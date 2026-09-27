import { EncodedAudioPacketSource, EncodedPacket, Mp4OutputFormat, Output } from 'mediabunny'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeOpfs, installFakeOpfs, readBlob } from '../test/fakeOpfs'
import { type ExportSink, openExportSink } from './exportSink'

// The real Mediabunny muxer over each sink, with VideoExporter's MP4 settings
// (fastStart 'reserve'). PCM audio packets stand in for encoded video: no
// codec is needed, and the reserve / positioned-write / close paths are the
// same ones an H.264 export takes.

const PACKET_FRAMES = 1024
const SAMPLE_RATE = 48_000

async function startMux(sink: ExportSink, packets: number): Promise<Output> {
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'reserve' }),
    target: sink.target,
  })
  const source = new EncodedAudioPacketSource('pcm-s16')
  output.addAudioTrack(source, { maximumPacketCount: packets + 8 })
  await output.start()
  const dur = PACKET_FRAMES / SAMPLE_RATE
  for (let i = 0; i < packets; i++) {
    const data = new Uint8Array(PACKET_FRAMES * 4).fill(i & 0xff)
    await source.add(
      new EncodedPacket(data, 'key', i * dur, dur),
      i === 0
        ? { decoderConfig: { codec: 'pcm-s16', sampleRate: SAMPLE_RATE, numberOfChannels: 2 } }
        : undefined,
    )
  }
  source.close()
  return output
}

const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes)

// Box type → offset, top level only.
function topLevelBoxes(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const boxes: string[] = []
  for (let pos = 0; pos + 8 <= bytes.length; ) {
    const size = view.getUint32(pos)
    boxes.push(ascii(bytes.subarray(pos + 4, pos + 8)))
    if (size < 8) break
    pos += size
  }
  return boxes
}

describe('openExportSink', () => {
  let fs: FakeOpfs | null = null
  afterEach(() => {
    fs?.uninstall()
    fs = null
  })

  it('muxes in memory where OPFS export is unsupported', async () => {
    const sink = await openExportSink(1024 * 1024)
    expect(sink.kind).toBe('memory')
    expect(sink.reason).toBe('unsupported')
    const output = await startMux(sink, 20)
    await output.finalize()
    const blob = await sink.finish()
    expect(blob.type).toBe('video/mp4')
    expect(topLevelBoxes(await readBlob(blob)).slice(0, 3)).toEqual(['ftyp', 'moov', 'free'])
    await sink.abort() // no-op
  })

  it('forces memory with the given reason (the retry after a failed file write)', async () => {
    fs = installFakeOpfs()
    const sink = await openExportSink(1024 * 1024, 'storage_failed')
    expect(sink.kind).toBe('memory')
    expect(sink.reason).toBe('storage_failed')
    expect(fs.files.size).toBe(0)
  })

  it('streams a fast-start MP4 into the OPFS file and commits it on finish()', async () => {
    fs = installFakeOpfs()
    const sink = await openExportSink(1024 * 1024)
    expect(sink.kind).toBe('opfs')
    expect(sink.reason).toBeNull()
    const output = await startMux(sink, 40)
    await output.finalize()
    // Mediabunny's finalize closed its target; the file is still uncommitted.
    expect(fs.log).toEqual([])
    const blob = await sink.finish()
    const [name] = [...fs.files.keys()]
    expect(fs.log).toEqual([`close ${name}`])
    const bytes = await readBlob(blob)
    expect(blob.type).toBe('video/mp4')
    expect(bytes).toEqual(fs.files.get(name!))
    // moov written back into its reserved slot ahead of the media.
    expect(topLevelBoxes(bytes)).toEqual(['ftyp', 'moov', 'free', 'mdat'])
    await sink.abort() // keeps the committed file: the download reads it
    expect(fs.files.has(name!)).toBe(true)
  })

  it('never commits a cancelled export: cancel closes the target, abort removes the file', async () => {
    fs = installFakeOpfs()
    const sink = await openExportSink(1024 * 1024)
    const output = await startMux(sink, 10)
    await output.cancel()
    expect(fs.log.some((l) => l.startsWith('close'))).toBe(false)
    const [name] = [...fs.files.keys()]
    await sink.abort()
    expect(fs.log).toEqual([`abort ${name}`, `remove ${name}`])
    expect(fs.files.size).toBe(0)
  })

  it('surfaces a quota failure mid-write as sink.failure and discards the file', async () => {
    fs = installFakeOpfs()
    fs.failWritesAfterBytes = 1024
    const sink = await openExportSink(1024 * 1024)
    const output = await startMux(sink, 40)
    await expect(output.finalize()).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(sink.failure).toMatchObject({ name: 'QuotaExceededError' })
    await sink.abort()
    expect(fs.files.size).toBe(0)
    expect(fs.log.some((l) => l.startsWith('close'))).toBe(false)
  })

  it('treats a failed commit as a storage failure too', async () => {
    fs = installFakeOpfs()
    fs.failClose = true
    const sink = await openExportSink(1024 * 1024)
    const output = await startMux(sink, 10)
    await output.finalize()
    await expect(sink.finish()).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(sink.failure).toMatchObject({ name: 'QuotaExceededError' })
    await sink.abort()
    expect(fs.files.size).toBe(0)
  })
})
