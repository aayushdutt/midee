// Single-pass H.264 MP4 via WebCodecs + Mediabunny (MP4 mux), with an optional AAC
// audio track. The audio is rendered (OfflineAudioRenderer, run by the caller
// through `ExportOptions.audio`) and encoded CONCURRENTLY with the video loop:
// the offline render happens on Chrome's audio thread and the video encoder in
// the codec process, so overlapping them costs no extra CPU and the wall time
// becomes max(audio, video) instead of the sum.
//
// Output is muxed into memory with `fastStart: 'reserve'` (the moov is
// reserved up front, so the file is held once, not assembled twice) and
// handed to the browser as a normal download — the downloads UI is the one
// place a user can open or reveal the file, which the File System Access
// path could not offer.
//
// Resilience: codec selection runs two probe passes (hardware-preferred, then
// software-preferred) and the export retries ONCE on a software plan when the
// hardware encoder dies mid-run. PostHog showed video_encode failures are
// concentrated on Linux/ChromeOS/iOS where the hardware probe passes but the
// encoder then errors at runtime — a single software retry rescues those.
// If the audio render fails the attempt is re-run without an audio track (an
// MP4 with an empty audio track is not something every player tolerates).
//
// Audio encoding is Mediabunny's (AudioSampleSource), not a hand-driven
// AudioEncoder: Safari's AudioEncoder emits a malformed AAC description that
// makes the track undecodable everywhere, and only Mediabunny's encoder path
// repairs it. The encoder itself is picked once per export by
// resolveAacEncoder() — native, or a WASM fallback for browsers without AAC
// (Safari ≤ 18). No encoder at all → the audio track is never declared and
// the offline render never starts.

import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  Quality,
} from 'mediabunny'
import { type AacEncoderKind, resolveAacEncoder } from './aacEncoder'

export type ExportStage =
  | 'Rendering audio'
  | 'Encoding audio'
  | 'Encoding'
  | 'Finalizing'
  | 'Saving'
  | 'Done'
export type ExportProgressCallback = (stage: ExportStage, pct: number) => void

export type ExportMode = 'av' | 'video-only' | 'audio-only'

export type HwPreference = 'prefer-hardware' | 'prefer-software'

export interface ExportPlanInfo {
  codec: string // human label, e.g. 'H.264 High 4.0'
  codecString: string
  hw: HwPreference
  attempt: number // 1-based
}

// Returned on success so the caller can attach real numbers to telemetry -
// failures were previously the only instrumented outcome with any detail.
export interface ExportStats {
  codec: string
  codecString: string
  hw: HwPreference
  attempts: number
  audioIncluded: boolean
  audioEncoder: AacEncoderKind | null // null when no audio track shipped
  // Frame-loop totals (ms) of the attempt that shipped: seek + scene render
  // (CPU submit only — WebGL work is async), VideoFrame(canvas) capture, and
  // time blocked on encoder backpressure. Whichever dominates says what bounds
  // this device: render → CPU scene work, capture → the GPU finishing the frame
  // plus the copy (where capture waits on it: Safari, software GL, weak GPUs —
  // so GPU/effects cost lands here), stall → the encoder (Chrome, fast GPUs).
  // Measured shape on an M4: Chrome stall-bound, Safari and headless capture-bound.
  renderMs: number
  captureMs: number
  stallMs: number
  // First encode() → first output chunk: the encoder's start-up (Chrome's
  // cold start is 3–9 s unless the dialog's pre-warm already paid it).
  firstChunkMs: number | null
  audioRenderMs: number // 0 when the caller passed a pre-rendered buffer
  audioEncodeMs: number
  videoEncodeMs: number
  finalizeMs: number
  outputBytes: number
  framesEncoded: number
}

// Produces the audio to mux. Called once, right after the muxer starts, so the
// offline render overlaps the video loop. `report` carries render progress in
// [0, 1]; the exporter decides whether it is shown (it is hidden while the
// video loop is the thing the user is waiting on). Resolve `null` for "no
// audio"; a rejection is treated the same way after `onAudioUnavailable`.
export type AudioProducer = (report: (pct: number) => void) => Promise<AudioBuffer | null>

// Where an 'av' export lost its soundtrack: the offline render failed, or
// there was no AAC encoder / the encode failed.
export type AudioUnavailableStage = 'audio_render' | 'audio_encode'

export interface ExportOptions {
  fps?: number
  duration: number
  bitrate?: number
  audio?: AudioBuffer | AudioProducer
  mode?: ExportMode
  filename?: string
  onProgress?: ExportProgressCallback
  // Fired at the start of every encode attempt with the chosen codec plan, so
  // the caller can report WHICH encoder path failed if the export later throws.
  onPlan?: (info: ExportPlanInfo) => void
  // Fired when a mid-run encoder failure triggers the software retry.
  onFallback?: (info: { fromCodec: string; toCodec: string; errorName: string }) => void
  // The soundtrack was lost (see AudioUnavailableStage); the export continues
  // without sound. Fires at most once per export.
  onAudioUnavailable?: (stage: AudioUnavailableStage, err: unknown) => void
  // Receives the finished MP4 instead of the browser download (bench); default downloads it.
  deliver?: (blob: Blob, filename: string) => void
  // Measurement only (the bench's `exportquality` suite) — the app never sets
  // it. `hardwareAcceleration` moves that codec plan first (the other stays as
  // the runtime-failure fallback; ExportStats.hw says which one shipped);
  // `latencyMode` replaces the shipped 'realtime'. Unset = shipped behaviour.
  encoderOverrides?: EncoderOverrides
  onRenderFrame: (time: number, dt: number) => void
  onSeek: (time: number) => void
}

export interface EncoderOverrides {
  hardwareAcceleration?: HwPreference
  latencyMode?: 'quality' | 'realtime'
}

interface CodecPlan {
  codecString: string // e.g. 'avc1.640028'
  muxerCodec: 'avc' | 'hevc' | 'vp9' | 'av1'
  label: string
  hw: HwPreference
}

const DEFAULT_FPS = 30
const DEFAULT_BITRATE = 8_000_000
const KEYFRAME_INTERVAL_SEC = 2
// Backpressure: wait when the queue exceeds this, until it's down to half.
// Shallow on purpose: every queued frame is a full-size GPU snapshot, and Chrome
// keeps only 3–5 frames inside the encoder anyway. On an M4 (Chrome 154 /
// Safari 26) depth 20 → 4 made real exports 26–55 % faster; 2 adds another
// +18–20 % in Chrome at 720p/1080p and ties 4 in Safari; 1–8 all hit the
// hardware ceiling at 4K; 8 and above get slower. Render-bound devices never
// fill the queue, so depth doesn't matter there
// (docs/EXPORT_PERF_MEASUREMENTS_2026-09-27.md).
const MAX_ENCODE_QUEUE = 2
const PROGRESS_UPDATE_EVERY_N_FRAMES = 3

const AUDIO_BITRATE = 192_000
// The encoder is chosen before the offline render exists, so the probe uses
// the format OfflineAudioRenderer always produces (44.1 kHz stereo). The
// encode itself is configured from the real buffer.
const AUDIO_PROBE_SAMPLE_RATE = 44_100
const AUDIO_PROBE_CHANNELS = 2
// Frames handed to Mediabunny per AudioSample (~3 s at 44.1 kHz). Mediabunny
// owns encoder backpressure; slicing only gives progress and cancellation a
// turn between pieces and bounds the copy to ~1 MB.
const AUDIO_SLICE_FRAMES = 1 << 17
const AAC_FRAME_SAMPLES = 1024
// Upper bound on the audio sample rate the offline renderer might hand us,
// for sizing the reserved moov before the buffer exists.
const MAX_AUDIO_SAMPLE_RATE = 48_000
// Progress contract: each stage reports `pct` in [0, 1] relative to that stage
// only. The UI owns mapping stages onto an overall bar (see ExportModal's
// stage windows) — the encoder just reports honest per-stage fractions.

// Thrown inside an attempt when the audio producer came back empty after the
// audio track was already declared; the attempt is re-run without audio.
class AudioUnavailableError extends Error {
  constructor() {
    super('Audio unavailable')
    this.name = 'AudioUnavailableError'
  }
}

// An error after the video encode finished (finalize/save). Not an encoder
// fault, so the codec-plan fallback must NOT re-encode the whole piece on
// the next plan; the caller gets the original error.
class PostEncodeError extends Error {
  constructor(readonly inner: unknown) {
    super('Export failed after encoding')
    this.name = 'PostEncodeError'
  }
}

export class VideoExporter {
  private cancelled = false
  private encoder: VideoEncoder | null = null
  private output: Output | null = null
  // Memoised across attempts: the offline render runs once per export even if
  // the encoder plan falls back.
  private audioResult: Promise<AudioBuffer | null> | null = null
  private audioRenderMs = 0
  // Where audio-render progress goes. Swapped per attempt; null while the
  // video loop is running so the bar tracks the stage the user is waiting on.
  private audioReport: ((pct: number) => void) | null = null
  private lastAudioPct = 0

  constructor(private canvas: HTMLCanvasElement) {}

  cancel(): void {
    this.cancelled = true
    // Close the video encoder eagerly so in-flight encode() calls surface as
    // errors rather than silently queueing more work after the abort. The
    // audio encoder is Mediabunny's; cancelling the Output tears it down.
    if (this.encoder && this.encoder.state !== 'closed') {
      this.encoder.close()
    }
    void this.output?.cancel().catch(() => {})
  }

  async export(opts: ExportOptions): Promise<ExportStats> {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new Error(
        'This browser does not support WebCodecs video export. ' +
          'Update to Chrome 94+, Safari 16.4+ or Firefox 130+.',
      )
    }

    const fps = opts.fps ?? DEFAULT_FPS
    const bitrate = opts.bitrate ?? DEFAULT_BITRATE

    // H.264 requires even dimensions (YUV 4:2:0 subsampling). Round the canvas
    // size down to the nearest even number and crop each frame via `visibleRect`
    // — costs at most one pixel on the right/bottom edge, never visible.
    const canvasW = this.canvas.width
    const canvasH = this.canvas.height
    if (canvasW < 2 || canvasH < 2) {
      throw new Error('Canvas is too small to export - resize the window and try again.')
    }
    const width = canvasW & ~1
    const height = canvasH & ~1

    const plans = await buildCodecPlans(width, height, fps, bitrate)
    const preferredHw = opts.encoderOverrides?.hardwareAcceleration
    if (preferredHw) {
      plans.sort((a, b) => Number(b.hw === preferredHw) - Number(a.hw === preferredHw))
    }

    const mode: ExportMode = opts.mode ?? 'av'
    let withAudio = mode === 'av' && opts.audio !== undefined
    // Resolved once, before any attempt: a codec-plan retry must not re-probe,
    // and with no encoder the audio track is never declared, so the offline
    // render never starts.
    let audioEncoder: AacEncoderKind | null = null
    if (withAudio) {
      audioEncoder = await resolveAacEncoder({
        sampleRate: AUDIO_PROBE_SAMPLE_RATE,
        numberOfChannels: AUDIO_PROBE_CHANNELS,
        bitrate: AUDIO_BITRATE,
      })
      if (!audioEncoder) {
        withAudio = false
        opts.onAudioUnavailable?.('audio_encode', new Error('No AAC encoder available'))
      }
    }
    let attempt = 0
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i]!
      attempt++
      opts.onPlan?.({
        codec: plan.label,
        codecString: plan.codecString,
        hw: plan.hw,
        attempt,
      })
      try {
        return await this.runAttempt(opts, plan, {
          fps,
          bitrate,
          width,
          height,
          attempt,
          audioEncoder: withAudio ? audioEncoder : null,
        })
      } catch (err) {
        const isCancel = err instanceof DOMException && err.name === 'AbortError'
        if (isCancel) throw err
        if (err instanceof PostEncodeError) throw err.inner
        if (err instanceof AudioUnavailableError) {
          // Same plan again, no audio track. The render result is memoised
          // (null), so this costs only the video pass.
          withAudio = false
          i--
          continue
        }
        const next = plans[i + 1]
        if (!next) throw err
        opts.onFallback?.({
          fromCodec: `${plan.label} (${plan.hw})`,
          toCodec: `${next.label} (${next.hw})`,
          errorName: err instanceof Error ? err.name : 'UnknownError',
        })
        console.warn(`Export attempt with ${plan.label} (${plan.hw}) failed; retrying`, err)
      }
    }
    // Unreachable: the loop either returns or rethrows on the last plan.
    throw new Error('Export failed on every codec plan')
  }

  // Starts (once) and returns the audio buffer. Producer failures resolve to
  // null so the export can continue without sound.
  private getAudio(opts: ExportOptions): Promise<AudioBuffer | null> {
    if (this.audioResult) return this.audioResult
    const src = opts.audio
    if (src === undefined) {
      this.audioResult = Promise.resolve(null)
    } else if (typeof src === 'function') {
      const started = performance.now()
      this.audioResult = src((pct) => {
        this.lastAudioPct = pct
        this.audioReport?.(pct)
      })
        .catch((err: unknown) => {
          console.error('Offline audio render failed:', err)
          opts.onAudioUnavailable?.('audio_render', err)
          return null
        })
        .then((buf) => {
          this.audioRenderMs = performance.now() - started
          return buf
        })
    } else {
      this.audioResult = Promise.resolve(src)
    }
    return this.audioResult
  }

  // One complete mux+encode pass with a fixed codec plan. Retries re-enter with
  // a fresh Output/muxer; the audio render is reused, only its encode repeats
  // (seconds at most, next to the minutes-long video pass it protects).
  private async runAttempt(
    opts: ExportOptions,
    plan: CodecPlan,
    cfg: {
      fps: number
      bitrate: number
      width: number
      height: number
      attempt: number
      // null = no audio track this attempt.
      audioEncoder: AacEncoderKind | null
    },
  ): Promise<ExportStats> {
    const { fps, bitrate, width, height, audioEncoder } = cfg
    const dt = 1 / fps
    const totalFrames = Math.max(1, Math.ceil(opts.duration * fps))

    const bufferTarget = new BufferTarget()
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'reserve' }),
      target: bufferTarget,
    })
    this.output = output
    const videoSource = new EncodedVideoPacketSource(plan.muxerCodec)
    output.addVideoTrack(videoSource, {
      frameRate: fps,
      maximumPacketCount: totalFrames + 8,
    })

    let audioSource: AudioSampleSource | null = null
    if (audioEncoder) {
      audioSource = new AudioSampleSource({
        codec: 'aac',
        quality: new Quality({ bitrate: AUDIO_BITRATE }),
      })
      // The renderer pads a tail past `duration`; +33% is Mediabunny's own
      // guidance for an estimate, +64 covers encoder priming/flush packets.
      const maxAudioPackets =
        Math.ceil(((opts.duration + 4) * MAX_AUDIO_SAMPLE_RATE * 1.34) / AAC_FRAME_SAMPLES) + 64
      output.addAudioTrack(audioSource, { maximumPacketCount: maxAudioPackets })
    }

    await output.start()

    // Audio pipeline, concurrent with the video loop below. Its progress is
    // silenced while video runs (the bar follows the encode); if it is still
    // going when the video finishes, the loop's tail surfaces it.
    let videoDone = false
    let audioEncodeMs = 0
    let audioMissing = false
    // Set when this attempt is being torn down (failure/retry). The audio task
    // outlives the attempt only as far as its render; it must not encode into
    // — or report errors from — a cancelled Output.
    let attemptOver = false
    const audioStopped = (): boolean => this.cancelled || attemptOver
    this.audioReport = null
    const audioTask = !audioSource
      ? Promise.resolve()
      : this.getAudio(opts)
          .then(async (buffer) => {
            if (!buffer) {
              audioMissing = true
              return
            }
            if (audioStopped()) return
            const src = audioSource
            const t0 = performance.now()
            await this.encodeAudio(buffer, src, audioStopped, (pct) => {
              if (videoDone) opts.onProgress?.('Encoding audio', pct)
            })
            src.close()
            audioEncodeMs = performance.now() - t0
          })
          .catch((err: unknown) => {
            // An audio ENCODE failure (encoder error, mux error) is not a
            // video-codec fault: degrade to a silent export on the same plan
            // instead of burning a full video pass on the fallback codec.
            if (audioStopped()) return
            console.error('Audio encode failed:', err)
            opts.onAudioUnavailable?.('audio_encode', err)
            audioMissing = true
          })

    // The video encoder error callback fires asynchronously. Capture the first
    // error so the frame loop can surface it on the next cancellation/error check.
    // Mediabunny's track `add()` is async (backpressure); chain so chunks stay ordered.
    let encoderError: Error | null = null
    let videoMuxDrain = Promise.resolve()
    // Where the frame loop's time goes, for telemetry (see ExportStats).
    const timing = { renderMs: 0, captureMs: 0, stallMs: 0, firstChunkMs: null as number | null }
    let firstEncodeAt = 0
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        timing.firstChunkMs ??= performance.now() - firstEncodeAt
        // Surface mux failures through check() rather than as an unobserved
        // rejection (a cancelled Output rejects any add() still queued).
        videoMuxDrain = videoMuxDrain
          .then(() => videoSource.add(EncodedPacket.fromEncodedChunk(chunk), meta))
          .catch((e: unknown) => {
            encoderError ??= e as Error
          })
      },
      error: (e) => {
        encoderError ??= e as Error
      },
    })
    this.encoder = encoder

    encoder.configure({
      codec: plan.codecString,
      width,
      height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: plan.hw,
      // 'realtime' skips the slower rate-distortion optimization passes the
      // encoder otherwise runs in 'quality' mode — ~1.5-2× faster encode for
      // the same bitrate, at a slight quality drop that is imperceptible at
      // the bitrates we target (typically YouTube re-encodes anyway). This
      // setting is unrelated to live audio latency — it only governs the
      // H.264 encoder's internal search depth.
      latencyMode: opts.encoderOverrides?.latencyMode ?? 'realtime',
    })

    const keyEvery = Math.max(1, Math.round(fps * KEYFRAME_INTERVAL_SEC))
    const videoStart = performance.now()
    let finalized = false

    const check = (): void => {
      this.throwIfStopped(encoderError)
      if (audioMissing) throw new AudioUnavailableError()
    }

    try {
      for (let i = 0; i < totalFrames; i++) {
        check()

        const t = i * dt
        const renderStart = performance.now()
        opts.onSeek(t)
        opts.onRenderFrame(t, dt)
        const captureStart = performance.now()

        const frame = new VideoFrame(this.canvas, {
          timestamp: Math.round((i * 1_000_000) / fps),
          visibleRect: { x: 0, y: 0, width, height },
          displayWidth: width,
          displayHeight: height,
        })
        const captureEnd = performance.now()
        timing.renderMs += captureStart - renderStart
        timing.captureMs += captureEnd - captureStart
        if (i === 0) firstEncodeAt = captureEnd
        encoder.encode(frame, { keyFrame: i % keyEvery === 0 })
        frame.close()

        if (i % PROGRESS_UPDATE_EVERY_N_FRAMES === 0) {
          opts.onProgress?.('Encoding', i / totalFrames)
        }

        // Backpressure: wake on the encoder's own dequeue event instead of
        // polling — no timer floor, and the loop resumes the instant there is
        // room. Otherwise yield every few frames so the audio pipeline and the
        // browser's own tasks get a turn.
        if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
          const stallStart = performance.now()
          while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE / 2) {
            check()
            await waitForDequeue(encoder)
          }
          timing.stallMs += performance.now() - stallStart
        } else if (i % 10 === 9) {
          await yieldToEventLoop()
        }
      }

      check()

      opts.onProgress?.('Finalizing', 0)
      await encoder.flush()
      check()
      await videoMuxDrain
      check()
      videoSource.close()
      const videoEncodeMs = performance.now() - videoStart

      // Video is done; if the audio is still rendering/encoding, show it.
      videoDone = true
      if (audioSource) {
        this.audioReport = (pct) => opts.onProgress?.('Rendering audio', pct)
        if (this.audioRenderMs === 0) opts.onProgress?.('Rendering audio', this.lastAudioPct)
        await audioTask
        this.audioReport = null
        check()
      }

      const finalizeStart = performance.now()
      opts.onProgress?.('Finalizing', 1)
      let outputBytes = 0
      let finalizeMs = 0
      try {
        // Also drains the audio encoder: Mediabunny flushes sources here, and
        // an encoder error on the last slice has no earlier place to surface.
        await output.finalize()
        finalized = true
        finalizeMs = performance.now() - finalizeStart

        opts.onProgress?.('Saving', 0)
        const buffer = bufferTarget.buffer
        if (!buffer) throw new Error('Export produced no file buffer')
        outputBytes = buffer.byteLength
        const blob = new Blob([buffer], { type: 'video/mp4' })
        const filename = opts.filename ?? 'midee.mp4'
        if (opts.deliver) opts.deliver(blob, filename)
        else triggerDownload(URL.createObjectURL(blob), filename)
      } catch (err) {
        const isCancel = err instanceof DOMException && err.name === 'AbortError'
        if (isCancel) throw err
        // With audio in play, a late audio-encoder failure and a mux failure
        // look the same from here (the audio encoder is the only one Mediabunny
        // runs). Retry silent once: if audio was the cause the user still gets
        // their video; if not, the silent attempt fails the same way and that
        // is the error reported.
        if (audioSource && !finalized) {
          console.error('Finalize failed with an audio track; retrying without audio:', err)
          opts.onAudioUnavailable?.('audio_encode', err)
          throw new AudioUnavailableError()
        }
        throw new PostEncodeError(err)
      }
      opts.onProgress?.('Saving', 1)
      opts.onProgress?.('Done', 1)

      return {
        codec: plan.label,
        codecString: plan.codecString,
        hw: plan.hw,
        attempts: cfg.attempt,
        audioIncluded: audioEncoder !== null,
        audioEncoder,
        renderMs: Math.round(timing.renderMs),
        captureMs: Math.round(timing.captureMs),
        stallMs: Math.round(timing.stallMs),
        firstChunkMs: timing.firstChunkMs === null ? null : Math.round(timing.firstChunkMs),
        audioRenderMs: Math.round(this.audioRenderMs),
        audioEncodeMs: Math.round(audioEncodeMs),
        videoEncodeMs: Math.round(videoEncodeMs),
        finalizeMs: Math.round(finalizeMs),
        outputBytes,
        framesEncoded: totalFrames,
      }
    } finally {
      videoDone = true
      this.audioReport = null
      if (encoder.state !== 'closed') encoder.close()
      this.encoder = null
      this.output = null
      if (!finalized) {
        // Stop this attempt's audio encode, then release the muxer (which
        // also closes Mediabunny's audio encoder and rejects any pending
        // add()). The audio task isn't awaited: a render still in flight is
        // memoised and picked up by the next attempt, and this attempt's
        // copy bails out as soon as it resolves.
        attemptOver = true
        await output.cancel().catch(() => {})
      }
    }
  }

  // Hands the rendered buffer to Mediabunny slice by slice. Mediabunny owns
  // the encoder (native or WASM, see resolveAacEncoder), its backpressure and
  // the Safari description repair; the slices only give progress and
  // cancellation a turn. `add()` rejects on an encoder or mux error.
  private async encodeAudio(
    audio: AudioBuffer,
    audioSource: AudioSampleSource,
    stopped: () => boolean,
    onProgress: (pct: number) => void,
  ): Promise<void> {
    const { numberOfChannels, sampleRate, length } = audio
    for (let offset = 0; offset < length; offset += AUDIO_SLICE_FRAMES) {
      if (stopped()) throw new DOMException('Export cancelled', 'AbortError')
      const frames = Math.min(AUDIO_SLICE_FRAMES, length - offset)
      // f32-planar layout: [ch0 samples..., ch1 samples..., ...]. A fresh
      // array per slice: the encoder may still read it after add() resolves.
      const data = new Float32Array(frames * numberOfChannels)
      for (let ch = 0; ch < numberOfChannels; ch++) {
        audio.copyFromChannel(data.subarray(ch * frames, (ch + 1) * frames), ch, offset)
      }
      const sample = new AudioSample({
        format: 'f32-planar',
        sampleRate,
        numberOfChannels,
        numberOfFrames: frames,
        timestamp: offset / sampleRate, // seconds
        data,
      })
      try {
        await audioSource.add(sample)
      } finally {
        sample.close()
      }
      if (stopped()) throw new DOMException('Export cancelled', 'AbortError')
      onProgress((offset + frames) / length)
      // Runs alongside the video loop on the same thread — give it (and the
      // browser) a turn between slices.
      await yieldToEventLoop()
    }
  }

  private throwIfStopped(encoderError: Error | null): void {
    if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')
    if (encoderError) throw encoderError
  }
}

// H.264 profiles in descending quality order. Probed per hardware preference.
const H264_CANDIDATES = [
  // Highest level first so the browser's first accept gives us the broadest
  // frame-size + MB/s budget. 5.2 is required for 4K@60 (4K@30 fits in 5.1);
  // 5.1 covers 4K@30 and 2K@60; 5.0 covers 2K@30 and 1080p@60.
  { codecString: 'avc1.640034', label: 'H.264 High 5.2 (4K@60)' },
  { codecString: 'avc1.640033', label: 'H.264 High 5.1 (4K@30)' },
  { codecString: 'avc1.640032', label: 'H.264 High 5.0 (2K)' },
  { codecString: 'avc1.640028', label: 'H.264 High 4.0' },
  { codecString: 'avc1.4D001F', label: 'H.264 Main 3.1' },
  { codecString: 'avc1.42E01F', label: 'H.264 Baseline 3.1' },
] as const

async function probeCodec(
  hw: HwPreference,
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<CodecPlan | null> {
  for (const c of H264_CANDIDATES) {
    const res = await VideoEncoder.isConfigSupported({
      codec: c.codecString,
      width,
      height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: hw,
    })
    if (res.supported) {
      return { codecString: c.codecString, muxerCodec: 'avc', label: c.label, hw }
    }
  }
  return null
}

// Ordered attempt plans: hardware-preferred first, software-preferred as the
// runtime-failure fallback. On machines with no usable hardware encoder
// (common on Linux / ChromeOS) the first probe returns null and the software
// plan becomes the primary — previously those users got a hard error.
async function buildCodecPlans(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<CodecPlan[]> {
  const hwPlan = await probeCodec('prefer-hardware', width, height, fps, bitrate)
  const swPlan = await probeCodec('prefer-software', width, height, fps, bitrate)

  // Even when both probes land on the same codec string the two plans differ
  // in `hardwareAcceleration`, which is exactly the knob the retry exists for.
  const plans: CodecPlan[] = []
  if (hwPlan) plans.push(hwPlan)
  if (swPlan) plans.push(swPlan)

  if (plans.length === 0) {
    throw new Error(
      'No supported H.264 profile was accepted by this browser for the current canvas size. ' +
        'Try a lower resolution or updating your browser.',
    )
  }
  return plans
}

// Resolves when the encoder takes something off its queue, or after a short
// timer in case the event is coalesced or never comes (closed encoder).
function waitForDequeue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      encoder.removeEventListener('dequeue', done)
      resolve()
    }
    const timer = setTimeout(done, 50)
    encoder.addEventListener('dequeue', done)
  })
}

// Lower-overhead yield for the keep-alive path. `scheduler.yield()` resolves
// on the next event loop tick without the ~4 ms setTimeout-0 clamp. Falls
// back to setTimeout for browsers that don't support the scheduler API.
function yieldToEventLoop(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scheduler = (globalThis as any).scheduler
  if (scheduler && typeof scheduler.yield === 'function') {
    return scheduler.yield() as Promise<void>
  }
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
