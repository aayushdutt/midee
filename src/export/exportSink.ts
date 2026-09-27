// The Mediabunny target one export attempt muxes into, and how the finished
// file comes back out: an OPFS file (disk) when opfsExports.ts says the
// browser can take it, else BufferTarget (memory). opfsExports.ts has the why,
// the choice rules and the file lifecycle; this is only the Mediabunny side.
//
// One sink per attempt: a codec-plan, no-audio or in-memory retry opens a
// fresh one, and `abort()` — a no-op once `finish()` has handed the file over
// — discards the attempt's file.
//
// fastStart 'reserve' (VideoExporter) works with the positioned writes: the
// moov is reserved up front and written back at its offset on finalize.
// Caveat: Mediabunny holds packets in RAM until EVERY track has one (it needs
// each track's decoder config to size the moov), and the audio track's first
// packet only arrives after the concurrent offline render — so video packets
// encoded in that window stay in memory even on OPFS: the video bitrate × the
// render's wall time × the encode speed (4K at 35 Mbps, 2× realtime, a 20 s
// render ≈ 175 MB). Bounded — typically seconds of render — and the file stays
// fast-start; `fastStart: false` (moov at the end) would lift it.

import { BufferTarget, StreamTarget, type Target } from 'mediabunny'
import { type MemorySinkReason, type OutputSinkKind, openOpfsExportFile } from './opfsExports'

export interface ExportSink {
  readonly kind: OutputSinkKind
  readonly reason: MemorySinkReason | null // why memory; null on OPFS
  readonly target: Target
  // First error writing or committing the file (quota exceeded, I/O). Always
  // null in memory. Set = a storage failure, whatever the muxer reported.
  readonly failure: unknown
  // After output.finalize(): the MP4 as a Blob (disk-backed on OPFS).
  finish(): Promise<Blob>
  // Discards the attempt's file unless finish() succeeded. Never rejects.
  abort(): Promise<void>
}

// `memoryReason` forces memory (the retry after an OPFS write failure).
export async function openExportSink(
  estimatedBytes: number,
  memoryReason: MemorySinkReason | null = null,
): Promise<ExportSink> {
  const opened = memoryReason
    ? { kind: 'memory' as const, reason: memoryReason }
    : await openOpfsExportFile(estimatedBytes)
  if (opened.kind === 'opfs') {
    const { file } = opened
    return {
      kind: 'opfs',
      reason: null,
      // Chunked: 16 MiB write-behind chunks, ≤ 2 held, instead of one write
      // per box/packet.
      target: new StreamTarget(file.writable, { chunked: true }),
      get failure() {
        return file.failure
      },
      finish: () => file.commit(),
      abort: () => file.discard(),
    }
  }
  const target = new BufferTarget()
  return {
    kind: 'memory',
    reason: opened.reason,
    target,
    failure: null,
    finish: async () => {
      const buffer = target.buffer
      if (!buffer) throw new Error('Export produced no file buffer')
      return new Blob([buffer], { type: 'video/mp4' })
    },
    abort: async () => {},
  }
}
