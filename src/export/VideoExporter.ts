// VideoExporter — single-pass H.264 MP4 via WebCodecs + mp4-muxer.
//
// Each rendered canvas frame is wrapped in a `VideoFrame` and fed directly to
// the browser's hardware `VideoEncoder`. Encoded chunks stream into a pure-JS
// MP4 muxer; the result is a playable MP4 blob with no second encode.
//
// Previously this module captured WebM via `MediaRecorder`, shipped the bytes
// through ffmpeg.wasm, and transcoded to H.264 — a double lossy pass with no
// GPU acceleration. WebCodecs replaces that with one native encode, typically
// 5–20× faster and better quality at the same bitrate.
//
// Audio is not captured yet. When audio export lands it can share this muxer
// by feeding an `AudioEncoder`'s chunks to `muxer.addAudioChunk(...)`.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

export type ExportStage = 'Encoding' | 'Finalizing' | 'Saving' | 'Done'
export type ExportProgressCallback = (stage: ExportStage, pct: number) => void

export interface ExportOptions {
  fps?: number
  duration: number
  bitrate?: number
  onProgress?: ExportProgressCallback
  onRenderFrame: (time: number, dt: number) => void
  onSeek: (time: number) => void
}

interface CodecPlan {
  codecString: string                          // e.g. 'avc1.640028'
  muxerCodec: 'avc' | 'hevc' | 'vp9' | 'av1'
  label: string
}

const DEFAULT_FPS = 30
const DEFAULT_BITRATE = 8_000_000
const KEYFRAME_INTERVAL_SEC = 2
const MAX_ENCODE_QUEUE = 20        // backpressure: yield when queue exceeds this
const PROGRESS_UPDATE_EVERY_N_FRAMES = 3

export class VideoExporter {
  private cancelled = false
  private encoder: VideoEncoder | null = null

  constructor(private canvas: HTMLCanvasElement) {}

  cancel(): void {
    this.cancelled = true
    // Close the encoder eagerly so in-flight encode() calls surface as errors
    // rather than silently queueing more work after the abort.
    if (this.encoder && this.encoder.state !== 'closed') {
      this.encoder.close()
    }
  }

  async export(opts: ExportOptions): Promise<void> {
    if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
      throw new Error(
        'This browser does not support WebCodecs video export. ' +
          'Update to Chrome 94+, Safari 16.4+ or Firefox 130+.',
      )
    }

    const fps = opts.fps ?? DEFAULT_FPS
    const bitrate = opts.bitrate ?? DEFAULT_BITRATE
    const dt = 1 / fps
    const totalFrames = Math.max(1, Math.ceil(opts.duration * fps))

    // H.264 requires even dimensions (YUV 4:2:0 subsampling). Round the canvas
    // size down to the nearest even number and crop each frame via `visibleRect`
    // — costs at most one pixel on the right/bottom edge, never visible.
    const canvasW = this.canvas.width
    const canvasH = this.canvas.height
    if (canvasW < 2 || canvasH < 2) {
      throw new Error('Canvas is too small to export — resize the window and try again.')
    }
    const width = canvasW & ~1
    const height = canvasH & ~1

    const plan = await pickCodec(width, height, fps, bitrate)

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: plan.muxerCodec, width, height, frameRate: fps },
      fastStart: 'in-memory',
    })

    // The encoder error callback fires asynchronously. Capture the first error
    // so the frame loop can surface it on the next cancellation/error check.
    let encoderError: Error | null = null
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encoderError ??= e as Error },
    })
    this.encoder = encoder

    encoder.configure({
      codec: plan.codecString,
      width, height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
    })

    const keyEvery = Math.max(1, Math.round(fps * KEYFRAME_INTERVAL_SEC))

    try {
      for (let i = 0; i < totalFrames; i++) {
        this.throwIfStopped(encoderError)

        const t = i * dt
        opts.onSeek(t)
        opts.onRenderFrame(t, dt)

        const frame = new VideoFrame(this.canvas, {
          timestamp: Math.round((i * 1_000_000) / fps),
          visibleRect: { x: 0, y: 0, width, height },
          displayWidth: width,
          displayHeight: height,
        })
        encoder.encode(frame, { keyFrame: i % keyEvery === 0 })
        frame.close()

        if (i % PROGRESS_UPDATE_EVERY_N_FRAMES === 0) {
          opts.onProgress?.('Encoding', (i / totalFrames) * 0.95)
        }

        // Backpressure: if the encoder is falling behind, wait rather than
        // blowing up memory with pending VideoFrames.
        if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
          while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE / 2) {
            this.throwIfStopped(encoderError)
            await yieldTask()
          }
        } else if (i % 10 === 9) {
          // Even when the encoder keeps up, periodically yield so the browser
          // can run event loop tasks and the UI stays responsive.
          await yieldTask()
        }
      }

      this.throwIfStopped(encoderError)

      opts.onProgress?.('Finalizing', 0.96)
      await encoder.flush()
      this.throwIfStopped(encoderError)

      muxer.finalize()

      opts.onProgress?.('Saving', 0.99)
      const { buffer } = muxer.target
      const blob = new Blob([buffer], { type: 'video/mp4' })
      triggerDownload(URL.createObjectURL(blob), 'pianoroll.mp4')
      opts.onProgress?.('Done', 1)
    } finally {
      if (encoder.state !== 'closed') encoder.close()
      this.encoder = null
    }
  }

  private throwIfStopped(encoderError: Error | null): void {
    if (this.cancelled) throw new DOMException('Export cancelled', 'AbortError')
    if (encoderError) throw encoderError
  }
}

// Probes a short list of H.264 profiles in descending quality order. Returns
// the first one the browser will actually hardware-encode at the given size.
async function pickCodec(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<CodecPlan> {
  const candidates: CodecPlan[] = [
    { codecString: 'avc1.640028', muxerCodec: 'avc', label: 'H.264 High 4.0' },
    { codecString: 'avc1.4D001F', muxerCodec: 'avc', label: 'H.264 Main 3.1' },
    { codecString: 'avc1.42E01F', muxerCodec: 'avc', label: 'H.264 Baseline 3.1' },
  ]

  for (const c of candidates) {
    const res = await VideoEncoder.isConfigSupported({
      codec: c.codecString,
      width, height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: 'prefer-hardware',
    })
    if (res.supported) return c
  }

  throw new Error(
    'No supported H.264 profile was accepted by this browser for the current canvas size. ' +
      'Try resizing the window or updating your browser.',
  )
}

function yieldTask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
