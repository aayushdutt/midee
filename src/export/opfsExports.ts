// Where a finished MP4 is assembled before it goes to the download: a file in
// the origin-private file system (OPFS, on disk) when the browser can stream
// into one, else memory (Mediabunny's BufferTarget — the pre-OPFS behaviour).
//
// Why: in memory a 5-min 4K export (35 Mbps ≈ 1.3 GB) peaks at ~3.5× the file.
// BufferTarget doubles its buffer as it grows (hard cap 4 GiB — bigger files
// fail), finalize copies it out with slice(), and the Blob copies it again:
// ~4.6 GB for that export. ~7 % of field exports died with no terminal event
// (export_interrupted — OOM / tab kill suspected, mostly 2K/4K). Streamed into
// OPFS, ~32–48 MiB of file data is in RAM at a time (Mediabunny's chunked
// StreamTarget: 16 MiB chunks, ≤ 2 held), and the File handed to the download
// is disk-backed in every engine.
//
// Not showSaveFilePicker (tried, removed): desktop-Chrome-only, needs a
// dialog, and the file never showed up in the browser's downloads UI. OPFS
// needs neither; the finished file goes through the same `downloadBlob`.
//
// Availability (main-thread createWritable): Chrome/Edge 86+, Chrome Android
// 109+, Firefox 111+, Safari/iOS 26+. Not in private windows (Chrome
// incognito's OPFS lives in RAM with a small quota — the quota check sends big
// exports to memory; Firefox private throws from getDirectory; Safari private
// has none), Android WebView, Safari Lockdown Mode, or Safari ≤ 18 (sync
// handles in workers only — not worth a worker). Missing or refused → memory.
//
// Rules (the pure parts are unit-tested):
//   · Room: free quota (estimate(): quota − usage) ≥ QUOTA_HEADROOM × the
//     file's upper bound (bitrate × duration + overhead). Chrome grants ~60 %
//     of the disk per origin (estimate() doesn't track free disk), Safari
//     ~60 %, Firefox min(10 % of disk, 10 GiB). Safari's close() copies its
//     temp file into OPFS (2× the file on disk for a moment) — hence headroom.
//   · Files: `exports/<session>-<createdAtMs>.mp4`, one session id per page
//     load. The file must outlive the export (the download reads it after we
//     hand it over), so it is removed at this tab's NEXT export, or — any
//     other session's — once older than STALE_AFTER_MS (swept at boot and at
//     each export). The age rule keeps a second tab's in-progress export and
//     its download safe; a tab killed mid-export leaves a file the next sweep
//     past the age limit removes.
//   · Commit: only `commit()` closes the real file stream. Mediabunny closes
//     its target on finalize AND on cancel / failed finalize, and closing a
//     FileSystemWritableFileStream commits whatever was written — so the
//     stream Mediabunny sees swallows close(), and `discard()` aborts +
//     removes instead.
//   · A write/commit failure (QuotaExceededError mid-write, I/O) is not a
//     codec fault: VideoExporter re-runs the attempt in memory when the file
//     is small enough (canRetryInMemory), else fails with ExportStorageError.
//
// Dependency-free (no Mediabunny) so app.ts can run the boot sweep without
// loading the exporter chunk; exportSink.ts builds the Mediabunny target.

export type OutputSinkKind = 'opfs' | 'memory'

// Why an export was muxed in memory:
//   unsupported    — no main-thread createWritable (Safari ≤ 18, WebView, old browsers)
//   unavailable    — the API exists but OPFS refused (private window, Lockdown Mode)
//   quota          — not enough free quota for the file (or no estimate)
//   storage_failed — an OPFS attempt failed to write its file; this is the retry
//   forced         — setExportSinkMode('memory') (devtools A/B)
export type MemorySinkReason = 'unsupported' | 'unavailable' | 'quota' | 'storage_failed' | 'forced'

const MiB = 1024 * 1024
export const EXPORT_DIR = 'exports'
export const QUOTA_HEADROOM = 1.5
// ftyp + the moov that fastStart 'reserve' sizes for maximumPacketCount
// (hundreds of KB for a long piece) + slack.
const FILE_OVERHEAD_BYTES = 8 * MiB
// Far longer than any export runs (p90 realtime factor 4–6× on a long piece),
// so another tab's in-progress file is never swept.
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000
// After an OPFS write failure the attempt re-runs in memory only up to this
// size (≈ 1080p for 8 min, 4K for 2 min): memory peaks at ~3.5× the file, and
// bigger is where the field's silent deaths were — a clear error beats an OOM
// after a second full encode.
export const MEMORY_RETRY_MAX_BYTES = 512 * MiB

// Per page load. Math.random, not crypto.randomUUID: this module loads at boot
// and randomUUID is missing outside secure contexts (LAN dev over http).
export const SESSION_ID = Math.random().toString(36).slice(2, 10).padEnd(8, '0')

// The write Mediabunny's StreamTarget emits — also a valid
// FileSystemWritableFileStream WriteParams, so it passes straight through.
export interface FileWriteChunk {
  type: 'write'
  data: Uint8Array<ArrayBuffer>
  position: number
}

// The OPFS file couldn't be written or committed and the export is too big to
// redo in memory. app.ts shows `error.export.storage` for it.
export class ExportStorageError extends Error {
  constructor(readonly inner: unknown) {
    super(
      `Could not write the export file (${inner instanceof Error ? `${inner.name}: ${inner.message}` : String(inner)})`,
    )
    this.name = 'ExportStorageError'
  }
}

let sinkMode: 'auto' | 'memory' = 'auto'

// Devtools A/B (peak memory of the two paths), like bakedGlow's switch — under
// `npm run dev`: (await import('/src/export/opfsExports.ts')).setExportSinkMode('memory')
export function setExportSinkMode(mode: 'auto' | 'memory'): void {
  sinkMode = mode
}

// ── Pure rules ────────────────────────────────────────────────────────────

// Upper bound on the MP4 an export produces. Encoders usually land well under
// the target bitrate on this content, so this over-estimates.
export function estimateExportBytes(
  videoBitrate: number,
  audioBitrate: number,
  durationS: number,
): number {
  return (
    Math.ceil(((videoBitrate + audioBitrate) / 8) * Math.max(0, durationS)) + FILE_OVERHEAD_BYTES
  )
}

export type SinkChoice = { kind: 'opfs' } | { kind: 'memory'; reason: MemorySinkReason }

export function chooseSink(input: {
  forced: boolean
  supported: boolean
  estimatedBytes: number
  estimate: StorageEstimate | null // null = estimate() missing or threw
}): SinkChoice {
  if (input.forced) return { kind: 'memory', reason: 'forced' }
  if (!input.supported) return { kind: 'memory', reason: 'unsupported' }
  const quota = input.estimate?.quota
  if (quota === undefined) return { kind: 'memory', reason: 'quota' }
  const free = quota - (input.estimate?.usage ?? 0)
  if (free < input.estimatedBytes * QUOTA_HEADROOM) return { kind: 'memory', reason: 'quota' }
  return { kind: 'opfs' }
}

export function canRetryInMemory(estimatedBytes: number): boolean {
  return estimatedBytes <= MEMORY_RETRY_MAX_BYTES
}

export function exportFileName(session: string, createdAt: number): string {
  return `${session}-${createdAt}.mp4`
}

// Not anchored at the end: a browser's side file for an entry (e.g. a
// `.crswap`, should one ever be listed) belongs to the same export.
const EXPORT_NAME = /^([a-z0-9]+)-(\d+)\.mp4/

export function parseExportFileName(name: string): { session: string; createdAt: number } | null {
  const m = EXPORT_NAME.exec(name)
  if (!m) return null
  return { session: m[1]!, createdAt: Number(m[2]) }
}

// Names to remove: this session's (its previous export — the tab is starting
// a new one) and any other session's older than STALE_AFTER_MS. Unknown names
// are left alone.
export function selectForSweep(names: readonly string[], session: string, now: number): string[] {
  return names.filter((name) => {
    const f = parseExportFileName(name)
    if (!f) return false
    return f.session === session || now - f.createdAt > STALE_AFTER_MS
  })
}

// ── Browser glue ──────────────────────────────────────────────────────────

export function opfsWritableSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle === 'function' &&
    typeof FileSystemFileHandle.prototype.createWritable === 'function'
  )
}

// lib.dom's async-iterable half isn't in tsconfig's `lib`.
type DirKeys = { keys(): AsyncIterable<string> }

async function sweepDir(dir: FileSystemDirectoryHandle, now: number): Promise<void> {
  const names: string[] = []
  try {
    for await (const name of (dir as unknown as DirKeys).keys()) names.push(name)
  } catch {
    return
  }
  for (const name of selectForSweep(names, SESSION_ID, now)) {
    // Refused while a writable is still open on it (another tab mid-export —
    // the age rule should already have spared it) or already gone: skip.
    await dir.removeEntry(name).catch(() => {})
  }
}

// App start: drop other sessions' stale files (killed tabs, old downloads).
// Fire-and-forget; never rejects, never creates the directory.
export async function sweepExportFiles(): Promise<void> {
  if (!opfsWritableSupported()) return
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(EXPORT_DIR)
    await sweepDir(dir, Date.now())
  } catch {
    // No exports directory yet (NotFoundError), or OPFS refused (private window).
  }
}

export interface OpfsExportFile {
  // What Mediabunny's StreamTarget writes into. Its close() is swallowed.
  readonly writable: WritableStream<FileWriteChunk>
  // First write or commit error (quota exceeded, I/O); null while healthy.
  readonly failure: unknown
  // Commits the file and returns it as a disk-backed Blob for the download.
  commit(): Promise<Blob>
  // Aborts the write and removes the file. No-op once committed: the download
  // may still be reading it.
  discard(): Promise<void>
}

// Wraps an open FileSystemWritableFileStream (`stream`) so that only commit()
// closes it. Exported for tests; openOpfsExportFile is the entry point.
export function guardExportFile(
  handle: Pick<FileSystemFileHandle, 'getFile'>,
  stream: WritableStream,
  remove: () => Promise<void>,
): OpfsExportFile {
  const out = stream.getWriter()
  let failure: unknown = null
  let committed = false
  let discarded = false
  const fail = (err: unknown): never => {
    failure ??= err
    throw err
  }
  const writable = new WritableStream<FileWriteChunk>({
    write: (chunk) => out.write(chunk).catch(fail),
    // Mediabunny also closes on cancel and on a failed finalize; a real close
    // here would commit the partial file.
    close: () => {},
    abort: (reason) => out.abort(reason).catch(() => {}),
  })
  return {
    writable,
    get failure() {
      return failure
    },
    async commit() {
      try {
        // Chrome renames its swap file (cheap); Safari copies its temp file in.
        await out.close()
        const file = await handle.getFile()
        committed = true
        // Firefox's OPFS File has an empty type. Wrapping doesn't copy.
        return new Blob([file], { type: 'video/mp4' })
      } catch (err) {
        return fail(err)
      }
    },
    async discard() {
      if (committed || discarded) return
      discarded = true
      await out.abort(new DOMException('Export discarded', 'AbortError')).catch(() => {})
      await remove().catch(() => {})
    },
  }
}

// Where an export of this size would be assembled, without opening a file —
// for the export dialog's large-file warning, which only applies in memory.
// Same rules as openOpfsExportFile. Never rejects.
export async function previewExportSink(estimatedBytes: number): Promise<SinkChoice> {
  const forced = sinkMode === 'memory'
  const supported = opfsWritableSupported()
  let estimate: StorageEstimate | null = null
  if (!forced && supported) {
    try {
      await navigator.storage.getDirectory()
    } catch {
      return { kind: 'memory', reason: 'unavailable' }
    }
    try {
      estimate = await navigator.storage.estimate()
    } catch {
      // No estimate → chooseSink says memory.
    }
  }
  return chooseSink({ forced, supported, estimatedBytes, estimate })
}

// Opens a fresh file for one export attempt, or says why the attempt should
// use memory. Never rejects.
export async function openOpfsExportFile(
  estimatedBytes: number,
): Promise<{ kind: 'opfs'; file: OpfsExportFile } | { kind: 'memory'; reason: MemorySinkReason }> {
  const forced = sinkMode === 'memory'
  const supported = opfsWritableSupported()
  const now = Date.now()
  let dir: FileSystemDirectoryHandle | null = null
  let estimate: StorageEstimate | null = null
  if (!forced && supported) {
    try {
      const root = await navigator.storage.getDirectory()
      dir = await root.getDirectoryHandle(EXPORT_DIR, { create: true })
    } catch (err) {
      console.warn('OPFS unavailable; exporting in memory:', err)
      return { kind: 'memory', reason: 'unavailable' }
    }
    // This tab's previous export + stale ones, before the quota check they count against.
    await sweepDir(dir, now)
    try {
      estimate = await navigator.storage.estimate()
    } catch {
      // No estimate → chooseSink says memory.
    }
  }
  const choice = chooseSink({ forced, supported, estimatedBytes, estimate })
  if (choice.kind === 'memory') return choice
  const exportsDir = dir
  if (!exportsDir) return { kind: 'memory', reason: 'unavailable' } // unreachable: opfs ⇒ dir
  const name = exportFileName(SESSION_ID, now)
  const remove = (): Promise<void> => exportsDir.removeEntry(name)
  try {
    const handle = await exportsDir.getFileHandle(name, { create: true })
    const stream = await handle.createWritable()
    return { kind: 'opfs', file: guardExportFile(handle, stream, remove) }
  } catch (err) {
    console.warn('OPFS file could not be opened; exporting in memory:', err)
    await remove().catch(() => {})
    return { kind: 'memory', reason: 'unavailable' }
  }
}
