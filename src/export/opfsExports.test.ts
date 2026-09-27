import { afterEach, describe, expect, it, vi } from 'vitest'
import { type FakeOpfs, installFakeOpfs, readBlob } from '../test/fakeOpfs'
import {
  canRetryInMemory,
  chooseSink,
  ExportStorageError,
  estimateExportBytes,
  exportFileName,
  type FileWriteChunk,
  guardExportFile,
  MEMORY_RETRY_MAX_BYTES,
  openOpfsExportFile,
  parseExportFileName,
  previewExportSink,
  QUOTA_HEADROOM,
  SESSION_ID,
  STALE_AFTER_MS,
  selectForSweep,
  setExportSinkMode,
  sweepExportFiles,
} from './opfsExports'

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const HOUR = 60 * 60 * 1000

describe('estimateExportBytes', () => {
  it('is bitrate × duration plus a fixed overhead', () => {
    // 5-min 4K at the preset's 35 Mbps + 192 kbps AAC ≈ 1.32 GB.
    const bytes = estimateExportBytes(35_000_000, 192_000, 300)
    expect(bytes).toBe(((35_000_000 + 192_000) / 8) * 300 + 8 * MiB)
  })

  it('never goes below the overhead', () => {
    expect(estimateExportBytes(8_000_000, 0, 0)).toBe(8 * MiB)
    expect(estimateExportBytes(8_000_000, 0, -5)).toBe(8 * MiB)
  })
})

describe('chooseSink', () => {
  const GB = 1024 ** 3
  const base = { forced: false, supported: true, estimatedBytes: 1 * GB }

  it('uses OPFS when supported with room for the file plus headroom', () => {
    expect(chooseSink({ ...base, estimate: { quota: 100 * GB, usage: 0 } })).toEqual({
      kind: 'opfs',
    })
  })

  it('falls back to memory when forced or unsupported, whatever the quota', () => {
    const estimate = { quota: 100 * GB, usage: 0 }
    expect(chooseSink({ ...base, forced: true, estimate })).toEqual({
      kind: 'memory',
      reason: 'forced',
    })
    expect(chooseSink({ ...base, supported: false, estimate })).toEqual({
      kind: 'memory',
      reason: 'unsupported',
    })
  })

  it('needs QUOTA_HEADROOM × the file free, counting existing usage', () => {
    const need = base.estimatedBytes * QUOTA_HEADROOM
    expect(chooseSink({ ...base, estimate: { quota: need, usage: 0 } }).kind).toBe('opfs')
    expect(chooseSink({ ...base, estimate: { quota: need + 10, usage: 11 } })).toEqual({
      kind: 'memory',
      reason: 'quota',
    })
    // Chrome incognito: in-RAM OPFS with a small quota → big exports go to memory.
    expect(chooseSink({ ...base, estimate: { quota: 300 * MiB, usage: 0 } }).kind).toBe('memory')
  })

  it('treats a missing estimate (or quota) as no room', () => {
    expect(chooseSink({ ...base, estimate: null })).toEqual({ kind: 'memory', reason: 'quota' })
    expect(chooseSink({ ...base, estimate: { usage: 0 } })).toEqual({
      kind: 'memory',
      reason: 'quota',
    })
  })

  it('reads a missing usage as zero', () => {
    expect(chooseSink({ ...base, estimate: { quota: 2 * GB } }).kind).toBe('opfs')
  })
})

describe('canRetryInMemory', () => {
  it('allows the in-memory retry only up to MEMORY_RETRY_MAX_BYTES', () => {
    expect(canRetryInMemory(MEMORY_RETRY_MAX_BYTES)).toBe(true)
    expect(canRetryInMemory(MEMORY_RETRY_MAX_BYTES + 1)).toBe(false)
    // 1080p for 5 min fits; 4K for 5 min doesn't.
    expect(canRetryInMemory(estimateExportBytes(8_000_000, 192_000, 300))).toBe(true)
    expect(canRetryInMemory(estimateExportBytes(35_000_000, 192_000, 300))).toBe(false)
  })
})

describe('export file names', () => {
  it('round-trips session and creation time', () => {
    const name = exportFileName('abc123', 1_790_000_000_000)
    expect(name).toBe('abc123-1790000000000.mp4')
    expect(parseExportFileName(name)).toEqual({ session: 'abc123', createdAt: 1_790_000_000_000 })
  })

  it('uses a lowercase alphanumeric session id', () => {
    expect(SESSION_ID).toMatch(/^[a-z0-9]{8}$/)
    expect(parseExportFileName(exportFileName(SESSION_ID, 1))?.session).toBe(SESSION_ID)
  })

  it('claims a side file of an export but nothing foreign', () => {
    expect(parseExportFileName('abc-123.mp4.crswap')).toEqual({ session: 'abc', createdAt: 123 })
    expect(parseExportFileName('notes.txt')).toBeNull()
    expect(parseExportFileName('abc.mp4')).toBeNull()
    expect(parseExportFileName('ABC-123.mp4')).toBeNull()
  })
})

describe('selectForSweep', () => {
  const now = 1_790_000_000_000

  it("removes this session's files at any age (the previous export)", () => {
    const names = [exportFileName('mine', now - 1000), exportFileName('mine', now - 10 * HOUR)]
    expect(selectForSweep(names, 'mine', now)).toEqual(names)
  })

  it("keeps another session's fresh file (a second tab mid-export or downloading)", () => {
    const fresh = exportFileName('other', now - 2 * HOUR)
    expect(selectForSweep([fresh], 'mine', now)).toEqual([])
  })

  it("removes another session's file once older than STALE_AFTER_MS (a killed tab)", () => {
    const edge = exportFileName('other', now - STALE_AFTER_MS)
    const stale = exportFileName('other', now - STALE_AFTER_MS - 1)
    expect(selectForSweep([edge, stale], 'mine', now)).toEqual([stale])
  })

  it('leaves unknown names and future timestamps (clock skew) alone', () => {
    const future = exportFileName('other', now + HOUR)
    expect(selectForSweep(['readme.txt', future], 'mine', now)).toEqual([])
  })
})

// A recording stand-in for the FileSystemWritableFileStream under the guard.
function recordingStream(opts: { failWrite?: boolean; failClose?: boolean } = {}) {
  const calls: string[] = []
  const stream = new WritableStream<FileWriteChunk>({
    write: (chunk) => {
      if (opts.failWrite) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      calls.push(`write ${chunk.position}+${chunk.data.byteLength}`)
    },
    close: () => {
      if (opts.failClose) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      calls.push('close')
    },
    abort: () => {
      calls.push('abort')
    },
  })
  return { stream, calls }
}

const chunk = (position: number, bytes: number): FileWriteChunk => ({
  type: 'write',
  data: new Uint8Array(bytes),
  position,
})

describe('guardExportFile', () => {
  const handle = { getFile: async () => new File([new Uint8Array([1, 2, 3])], 'x.mp4') }

  it('passes writes through and swallows the muxer close (no commit)', async () => {
    const { stream, calls } = recordingStream()
    const remove = vi.fn(async () => {})
    const file = guardExportFile(handle, stream, remove)
    const w = file.writable.getWriter()
    await w.write(chunk(0, 16))
    await w.write(chunk(4, 8))
    // Mediabunny closes its target on cancel too — that must not commit.
    await w.close()
    expect(calls).toEqual(['write 0+16', 'write 4+8'])
    await file.discard()
    expect(calls).toEqual(['write 0+16', 'write 4+8', 'abort'])
    expect(remove).toHaveBeenCalledTimes(1)
    expect(file.failure).toBeNull()
  })

  it('commits on commit() and returns a video/mp4 Blob of the file', async () => {
    const { stream, calls } = recordingStream()
    const remove = vi.fn(async () => {})
    const file = guardExportFile(handle, stream, remove)
    const w = file.writable.getWriter()
    await w.write(chunk(0, 3))
    await w.close()
    const blob = await file.commit()
    expect(calls).toEqual(['write 0+3', 'close'])
    expect(blob.type).toBe('video/mp4')
    expect([...(await readBlob(blob))]).toEqual([1, 2, 3])
    // The download may still be reading it: discard after commit keeps it.
    await file.discard()
    expect(remove).not.toHaveBeenCalled()
    expect(calls).not.toContain('abort')
  })

  it('records a write failure, errors the stream the muxer sees, and discards', async () => {
    const { stream } = recordingStream({ failWrite: true })
    const remove = vi.fn(async () => {})
    const file = guardExportFile(handle, stream, remove)
    const w = file.writable.getWriter()
    await expect(w.write(chunk(0, 16))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(file.failure).toMatchObject({ name: 'QuotaExceededError' })
    await expect(w.ready).rejects.toBeDefined()
    await file.discard()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('records a commit failure (Safari copy-in out of space) and still discards', async () => {
    const { stream } = recordingStream({ failClose: true })
    const remove = vi.fn(async () => {})
    const file = guardExportFile(handle, stream, remove)
    await expect(file.commit()).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(file.failure).toMatchObject({ name: 'QuotaExceededError' })
    await file.discard()
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('discard never rejects, even when removal fails', async () => {
    const { stream } = recordingStream()
    const file = guardExportFile(handle, stream, async () => {
      throw new DOMException('locked', 'NoModificationAllowedError')
    })
    await expect(file.discard()).resolves.toBeUndefined()
  })
})

describe('ExportStorageError', () => {
  it('names the inner error for telemetry', () => {
    const err = new ExportStorageError(new DOMException('Quota exceeded', 'QuotaExceededError'))
    expect(err.name).toBe('ExportStorageError')
    expect(err.message).toContain('QuotaExceededError')
  })
})

describe('previewExportSink (fake OPFS) — the dialog warning', () => {
  let fs: FakeOpfs | null = null
  afterEach(() => {
    fs?.uninstall()
    fs = null
  })

  it('is memory without main-thread createWritable (jsdom, Safari ≤ 18)', async () => {
    expect(await previewExportSink(GiB)).toEqual({ kind: 'memory', reason: 'unsupported' })
  })

  it('is OPFS with room, memory without — and never creates a file', async () => {
    fs = installFakeOpfs()
    expect(await previewExportSink(GiB)).toEqual({ kind: 'opfs' })
    fs.quota = GiB // incognito-sized quota: a 1 GiB export needs 1.5 GiB free
    expect(await previewExportSink(GiB)).toEqual({ kind: 'memory', reason: 'quota' })
    fs.refuseDirectory = true // Firefox private window
    expect(await previewExportSink(GiB)).toEqual({ kind: 'memory', reason: 'unavailable' })
    expect(fs.files.size).toBe(0)
  })
})

describe('openOpfsExportFile (fake OPFS)', () => {
  let fs: FakeOpfs | null = null
  const install = (): FakeOpfs => {
    fs = installFakeOpfs()
    return fs
  }
  afterEach(() => {
    fs?.uninstall()
    fs = null
    setExportSinkMode('auto')
  })

  it('says unsupported without main-thread createWritable (jsdom, Safari ≤ 18)', async () => {
    expect(await openOpfsExportFile(MiB)).toEqual({ kind: 'memory', reason: 'unsupported' })
  })

  it('honours the devtools memory switch without touching OPFS', async () => {
    const opfs = install()
    setExportSinkMode('memory')
    expect(await openOpfsExportFile(MiB)).toEqual({ kind: 'memory', reason: 'forced' })
    expect(opfs.files.size).toBe(0)
  })

  it('says unavailable when getDirectory refuses (Firefox private window)', async () => {
    const opfs = install()
    opfs.refuseDirectory = true
    expect(await openOpfsExportFile(MiB)).toEqual({ kind: 'memory', reason: 'unavailable' })
  })

  it('says unavailable and leaves no entry when createWritable refuses', async () => {
    const opfs = install()
    opfs.refuseWritable = true
    expect(await openOpfsExportFile(MiB)).toEqual({ kind: 'memory', reason: 'unavailable' })
    expect(opfs.files.size).toBe(0)
  })

  it('says quota and creates no file when the estimate has no room', async () => {
    const opfs = install()
    opfs.quota = 100 * MiB
    opfs.usage = 90 * MiB
    expect(await openOpfsExportFile(20 * MiB)).toEqual({ kind: 'memory', reason: 'quota' })
    expect(opfs.files.size).toBe(0)
  })

  it("opens this session's file after sweeping its previous one and stale ones", async () => {
    const opfs = install()
    const now = Date.now()
    const previous = exportFileName(SESSION_ID, now - 60_000)
    const otherFresh = exportFileName('othertab', now - HOUR)
    const otherStale = exportFileName('deadtab', now - STALE_AFTER_MS - HOUR)
    for (const name of [previous, otherFresh, otherStale]) opfs.files.set(name, new Uint8Array(1))

    const opened = await openOpfsExportFile(MiB)
    expect(opened.kind).toBe('opfs')
    const names = [...opfs.files.keys()]
    expect(names).toContain(otherFresh)
    expect(names).not.toContain(previous)
    expect(names).not.toContain(otherStale)
    const mine = names.filter((n) => parseExportFileName(n)?.session === SESSION_ID)
    expect(mine).toHaveLength(1)

    if (opened.kind !== 'opfs') return
    const w = opened.file.writable.getWriter()
    await w.write({ type: 'write', data: new Uint8Array([9, 8, 7]), position: 0 })
    await w.close()
    // Muxer's close alone must not have committed anything.
    expect(opfs.files.get(mine[0]!)).toEqual(new Uint8Array(0))
    const blob = await opened.file.commit()
    expect([...(await readBlob(blob))]).toEqual([9, 8, 7])
    expect(opfs.log).toContain(`close ${mine[0]}`)
  })

  it('removes the file when the attempt is discarded', async () => {
    const opfs = install()
    const opened = await openOpfsExportFile(MiB)
    if (opened.kind !== 'opfs') throw new Error('expected opfs')
    const [name] = [...opfs.files.keys()]
    await opened.file.discard()
    expect(opfs.files.size).toBe(0)
    expect(opfs.log).toEqual([`abort ${name}`, `remove ${name}`])
  })
})

describe('sweepExportFiles (boot)', () => {
  let fs: FakeOpfs | null = null
  afterEach(() => {
    fs?.uninstall()
    fs = null
  })

  it('is a no-op without OPFS support', async () => {
    await expect(sweepExportFiles()).resolves.toBeUndefined()
  })

  it('never rejects, and never creates the directory, when there is nothing yet', async () => {
    fs = installFakeOpfs()
    await expect(sweepExportFiles()).resolves.toBeUndefined()
    expect(fs.log).toEqual([])
  })

  it("removes other sessions' stale files and keeps fresh ones", async () => {
    fs = installFakeOpfs()
    // Create the directory the way an export does.
    const opened = await openOpfsExportFile(MiB)
    if (opened.kind === 'opfs') await opened.file.discard()
    const now = Date.now()
    const fresh = exportFileName('othertab', now - HOUR)
    const stale = exportFileName('deadtab', now - STALE_AFTER_MS - HOUR)
    fs.files.set(fresh, new Uint8Array(1))
    fs.files.set(stale, new Uint8Array(1))
    fs.log.length = 0
    await sweepExportFiles()
    expect([...fs.files.keys()]).toEqual([fresh])
    expect(fs.log).toEqual([`remove ${stale}`])
  })
})
