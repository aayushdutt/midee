// Pre-warms the video encoder while the export dialog is open. Chrome's first
// VideoEncoder of a browser session takes 3–9 s to emit its first chunk (GPU
// process / VideoToolbox start-up; measured on an M4, Chrome 153/154 —
// docs/EXPORT_PERF_MEASUREMENTS_2026-09-27.md); every later encoder starts in
// tens of ms. Encoding one tiny frame while the user is still picking settings
// takes that wait off the export. Safari starts in < 0.4 s, so it's a cheap
// no-op there.
//
// The warm-up encoder is closed straight away (Android and NVIDIA cap
// concurrent encoder sessions); the start-up cost stays paid. Same codec
// family and hardware preference as VideoExporter's first plan. Standalone and
// dependency-free so the dialog can call it without loading the exporter chunk.

const WARMUP: VideoEncoderConfig = {
  codec: 'avc1.640028', // H.264 High — the exporter's ladder is all High
  width: 320,
  height: 180,
  bitrate: 500_000,
  framerate: 30,
  hardwareAcceleration: 'prefer-hardware',
  latencyMode: 'realtime',
}

let warming: Promise<void> | null = null

/** Idempotent per page load; never rejects. */
export function prewarmVideoEncoder(): Promise<void> {
  warming ??= warm().catch(() => {})
  return warming
}

async function warm(): Promise<void> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return
  if (!(await VideoEncoder.isConfigSupported(WARMUP)).supported) return
  const { width, height } = WARMUP
  const encoder = new VideoEncoder({ output: () => {}, error: () => {} })
  try {
    encoder.configure(WARMUP)
    const frame = new VideoFrame(new Uint8Array((width * height * 3) / 2), {
      format: 'I420',
      codedWidth: width,
      codedHeight: height,
      timestamp: 0,
    })
    encoder.encode(frame, { keyFrame: true })
    frame.close()
    await encoder.flush()
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }
}
