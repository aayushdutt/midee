// Shared H.264 encode loop for the encoder-ceiling bench suites (`encodemax`,
// `encodepar` in runner.ts). Imported on the main thread by runner.ts and
// inside DedicatedWorkers by encodeWorker.ts, so both sides drive the encoder
// identically. Nothing here renders: frames come from a pre-rendered pool and
// are re-wrapped per encode with a fresh timestamp (`new VideoFrame(frame,
// { timestamp })` shares the pooled frame's resource — no copy), which prices
// the encoder alone. See docs/EXPORT_PERF_MEASUREMENTS_2026-09-27.md.
//
// Keep this module free of app imports: the worker bundle must stay tiny.

export type HwPref = 'prefer-hardware' | 'prefer-software' | 'no-preference'

// VideoExporter's H264_CANDIDATES codec strings, same order (highest level
// first — the product takes the first one the browser accepts). Duplicated
// because product code doesn't export it; keep the two in step.
const H264_LADDER = [
  'avc1.640034',
  'avc1.640033',
  'avc1.640032',
  'avc1.640028',
  'avc1.4D001F',
  'avc1.42E01F',
] as const

// Mirrors VideoExporter: keyframe every 2 s, backpressure above 2 queued
// frames down to 1, woken by `dequeue` with a 50 ms timer fallback. (Runs
// before 2026-09-27's queue change used 20/10.)
const KEYFRAME_INTERVAL_SEC = 2
const MAX_QUEUE = 2
const DEQUEUE_TIMEOUT_MS = 50

export interface EncodeTarget {
  width: number
  height: number
  fps: number
  bitrate: number
  hw: HwPref
}

// The config VideoExporter would configure for this target (latencyMode
// 'realtime'), on the first ladder entry the browser accepts; null when none is.
export async function probeH264(t: EncodeTarget): Promise<VideoEncoderConfig | null> {
  for (const codec of H264_LADDER) {
    const config: VideoEncoderConfig = {
      codec,
      width: t.width,
      height: t.height,
      bitrate: t.bitrate,
      framerate: t.fps,
      hardwareAcceleration: t.hw,
      latencyMode: 'realtime',
    }
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config
    } catch {
      // some engines throw instead of answering supported: false
    }
  }
  return null
}

export interface EncodeRunResult {
  // Wall-clock ms (performance.timeOrigin + now) of every output chunk.
  // Absolute so main-thread and worker timelines can be merged.
  outTimes: number[]
  bytes: number
  frames: number
  startMs: number // first encode()
  endMs: number // flush() resolved
  stallMs: number // blocked on backpressure
  dequeues: number // 'dequeue' events seen (0 = engine never fires them)
}

export function wallNow(): number {
  return performance.timeOrigin + performance.now()
}

// Encodes `frames` frames cycling through `pool`. Resolves after flush; rejects
// on an encoder error. Does not close the pool.
export async function runEncodeLoop(opts: {
  config: VideoEncoderConfig
  pool: readonly VideoFrame[]
  frames: number
  fps: number
}): Promise<EncodeRunResult> {
  const { config, pool, frames, fps } = opts
  if (pool.length === 0) throw new Error('encode loop: empty frame pool')
  const outTimes: number[] = []
  let bytes = 0
  let dequeues = 0
  let failure: Error | null = null
  const encoder = new VideoEncoder({
    output: (chunk) => {
      outTimes.push(wallNow())
      bytes += chunk.byteLength
    },
    error: (e) => {
      failure ??= e instanceof Error ? e : new Error(String(e))
    },
  })
  encoder.addEventListener('dequeue', () => {
    dequeues++
  })
  encoder.configure(config)
  const keyEvery = Math.max(1, Math.round(fps * KEYFRAME_INTERVAL_SEC))
  let stallMs = 0
  const startMs = wallNow()
  try {
    for (let i = 0; i < frames; i++) {
      if (failure) throw failure
      const frame = new VideoFrame(pool[i % pool.length]!, {
        timestamp: Math.round((i * 1_000_000) / fps),
      })
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 })
      frame.close()
      if (encoder.encodeQueueSize > MAX_QUEUE) {
        const s0 = wallNow()
        while (encoder.encodeQueueSize > MAX_QUEUE / 2) {
          if (failure) throw failure
          await waitForDequeue(encoder)
        }
        stallMs += wallNow() - s0
      } else if (i % 10 === 9) {
        await yieldNow()
      }
    }
    await encoder.flush()
    if (failure) throw failure
    return { outTimes, bytes, frames, startMs, endMs: wallNow(), stallMs, dequeues }
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }
}

// Same shape as VideoExporter's waitForDequeue.
export function waitForDequeue(encoder: VideoEncoder): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      encoder.removeEventListener('dequeue', done)
      resolve()
    }
    const timer = setTimeout(done, DEQUEUE_TIMEOUT_MS)
    encoder.addEventListener('dequeue', done)
  })
}

// VideoExporter's yieldToEventLoop: scheduler.yield where it exists, else setTimeout 0.
export function yieldNow(): Promise<void> {
  const s = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  return s?.yield ? s.yield() : new Promise((r) => setTimeout(r, 0))
}

// Concurrent throughput of several encoders, given each one's output-chunk
// times: outputs per second inside the window where every encoder is past
// its warm-up (first `skip` of its outputs) and none has finished yet. For
// one encoder this is its steady-state rate, free of configure/first-frame
// latency and the flush tail.
export function steadyFps(outTimes: readonly (readonly number[])[], skip = 0.1): number {
  if (outTimes.length === 0 || outTimes.some((t) => t.length < 4)) return -1
  const start = Math.max(...outTimes.map((t) => t[Math.floor(t.length * skip)]!))
  const end = Math.min(...outTimes.map((t) => t[t.length - 1]!))
  if (!(end > start)) return -1
  let n = 0
  for (const times of outTimes) for (const t of times) if (t > start && t <= end) n++
  return n / ((end - start) / 1000)
}

// Whole-run throughput including configure latency and the flush tail.
export function overallFps(runs: readonly EncodeRunResult[]): number {
  const start = Math.min(...runs.map((r) => r.startMs))
  const end = Math.max(...runs.map((r) => r.endMs))
  const frames = runs.reduce((n, r) => n + r.frames, 0)
  return end > start ? frames / ((end - start) / 1000) : -1
}
