// Minimal, dependency-free ISO-BMFF (MP4) inspector for e2e assertions.
//
// We deliberately avoid pulling Mediabunny into the Node test process — the app
// already produces the file; here we only need to PROVE it is a structurally valid
// MP4 with the expected tracks, duration and AAC config. Parsing a few boxes is
// enough and has zero runtime dependencies, so it can't drift from the app.
// Decoding (does it actually play?) lives in ./decode.ts.
//
// References: ISO/IEC 14496-12. Box = [4-byte big-endian size][4-byte type][payload].
// size===1 means a 64-bit largesize follows the type; size===0 means "to EOF".

export interface Mp4Box {
  type: string
  start: number
  size: number
  /** Byte offset of the box payload (after the 8- or 16-byte header). */
  payloadStart: number
  payloadSize: number
}

/** Parse the top-level box list of an MP4 buffer. */
export function parseTopLevelBoxes(buf: Uint8Array): Mp4Box[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const boxes: Mp4Box[] = []
  let offset = 0
  while (offset + 8 <= buf.byteLength) {
    let size = dv.getUint32(offset)
    const type = readType(buf, offset + 4)
    let headerSize = 8
    if (size === 1) {
      // 64-bit largesize. JS numbers are safe well past any test file size.
      const hi = dv.getUint32(offset + 8)
      const lo = dv.getUint32(offset + 12)
      size = hi * 2 ** 32 + lo
      headerSize = 16
    } else if (size === 0) {
      size = buf.byteLength - offset
    }
    if (size < headerSize || offset + size > buf.byteLength) break
    boxes.push({
      type,
      start: offset,
      size,
      payloadStart: offset + headerSize,
      payloadSize: size - headerSize,
    })
    offset += size
  }
  return boxes
}

function readType(buf: Uint8Array, at: number): string {
  return String.fromCharCode(buf[at]!, buf[at + 1]!, buf[at + 2]!, buf[at + 3]!)
}

/**
 * Read the movie duration (seconds) from the `moov > mvhd` box. Works for both
 * version 0 (32-bit) and version 1 (64-bit) mvhd. Returns null if not found.
 */
export function readMovieDurationSeconds(buf: Uint8Array): number | null {
  const top = parseTopLevelBoxes(buf)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) return null
  const mvhd = findChild(buf, moov, 'mvhd')
  if (!mvhd) return null
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const p = mvhd.payloadStart
  const version = buf[p]!
  if (version === 1) {
    // version(1) flags(3) ctime(8) mtime(8) timescale(4) duration(8)
    const timescale = dv.getUint32(p + 4 + 8 + 8)
    const hi = dv.getUint32(p + 4 + 8 + 8 + 4)
    const lo = dv.getUint32(p + 4 + 8 + 8 + 8)
    const duration = hi * 2 ** 32 + lo
    return timescale ? duration / timescale : null
  }
  // version 0: version(1) flags(3) ctime(4) mtime(4) timescale(4) duration(4)
  const timescale = dv.getUint32(p + 4 + 4 + 4)
  const duration = dv.getUint32(p + 4 + 4 + 4 + 4)
  return timescale ? duration / timescale : null
}

/**
 * Count `trak` boxes and classify each as 'vide' (video) or 'soun' (audio) via the
 * nested `trak > mdia > hdlr` handler type.
 */
export function readTrackHandlers(buf: Uint8Array): string[] {
  const top = parseTopLevelBoxes(buf)
  const moov = top.find((b) => b.type === 'moov')
  if (!moov) return []
  const handlers: string[] = []
  for (const trak of findChildren(buf, moov, 'trak')) {
    const mdia = findChild(buf, trak, 'mdia')
    if (!mdia) continue
    const hdlr = findChild(buf, mdia, 'hdlr')
    if (!hdlr) continue
    // hdlr: version(1) flags(3) pre_defined(4) handler_type(4)
    handlers.push(readType(buf, hdlr.payloadStart + 8))
  }
  return handlers
}

export interface AudioSpecificConfig {
  objectType: number // 2 = AAC-LC; 0 = the malformed config Safari 26 emits
  sampleRate: number
  channels: number
}

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

/**
 * The AAC AudioSpecificConfig of the first `mp4a` track, read from
 * `moov > trak > mdia > minf > stbl > stsd > mp4a > esds`. This is what every
 * player parses before decoding a sample — a bad one means a silent or
 * missing audio track (WebKit bug 302253 put a whole ES_Descriptor here).
 */
export function readAudioSpecificConfig(buf: Uint8Array): AudioSpecificConfig | null {
  const moov = parseTopLevelBoxes(buf).find((b) => b.type === 'moov')
  if (!moov) return null
  for (const trak of findChildren(buf, moov, 'trak')) {
    let stsd: Mp4Box | undefined = trak
    for (const type of ['mdia', 'minf', 'stbl', 'stsd']) stsd = stsd && findChild(buf, stsd, type)
    if (!stsd) continue
    // stsd: version/flags(4) entry_count(4), then sample-entry boxes.
    const mp4a = childBoxes(buf, stsd, 8).find((b) => b.type === 'mp4a')
    if (!mp4a) continue
    // AudioSampleEntry: 28 bytes of fields before its child boxes.
    const esds = childBoxes(buf, mp4a, 28).find((b) => b.type === 'esds')
    return esds
      ? parseEsds(buf.subarray(esds.payloadStart, esds.payloadStart + esds.payloadSize))
      : null
  }
  return null
}

/** `esds` payload (version/flags + ES_Descriptor) → its AudioSpecificConfig. */
export function parseEsds(payload: Uint8Array): AudioSpecificConfig | null {
  let i = 4 // version/flags
  const readDescriptor = (): { tag: number; end: number } => {
    const tag = payload[i++]!
    let len = 0
    for (let k = 0; k < 4; k++) {
      const b = payload[i++]!
      len = (len << 7) | (b & 0x7f)
      if (!(b & 0x80)) break
    }
    return { tag, end: i + len }
  }
  if (readDescriptor().tag !== 0x03) return null // ES_Descriptor
  i += 2 // ES_ID
  const flags = payload[i++]!
  if (flags & 0x80) i += 2 // dependsOn_ES_ID
  if (flags & 0x40) i += 1 + payload[i]! // URL
  if (flags & 0x20) i += 2 // OCR_ES_ID
  if (readDescriptor().tag !== 0x04) return null // DecoderConfigDescriptor
  i += 13 // objectTypeIndication, streamType, bufferSizeDB, maxBitrate, avgBitrate
  const dsi = readDescriptor()
  if (dsi.tag !== 0x05) return null // DecoderSpecificInfo = the AudioSpecificConfig
  return parseAudioSpecificConfig(payload.subarray(i, dsi.end))
}

function parseAudioSpecificConfig(asc: Uint8Array): AudioSpecificConfig {
  let bit = 0
  const read = (n: number): number => {
    let v = 0
    for (let k = 0; k < n; k++, bit++) v = (v << 1) | ((asc[bit >> 3]! >> (7 - (bit & 7))) & 1)
    return v
  }
  let objectType = read(5)
  if (objectType === 31) objectType = 32 + read(6)
  const freqIndex = read(4)
  const sampleRate = freqIndex === 15 ? read(24) : (AAC_SAMPLE_RATES[freqIndex] ?? 0)
  return { objectType, sampleRate, channels: read(4) }
}

// `skip` = fixed-size fields at the start of the payload before child boxes.
function childBoxes(buf: Uint8Array, parent: Mp4Box, skip = 0): Mp4Box[] {
  const from = parent.payloadStart + skip
  const slice = buf.subarray(from, parent.payloadStart + parent.payloadSize)
  return parseTopLevelBoxes(slice).map((b) => ({
    ...b,
    start: b.start + from,
    payloadStart: b.payloadStart + from,
  }))
}

function findChild(buf: Uint8Array, parent: Mp4Box, type: string): Mp4Box | undefined {
  return childBoxes(buf, parent).find((b) => b.type === type)
}

function findChildren(buf: Uint8Array, parent: Mp4Box, type: string): Mp4Box[] {
  return childBoxes(buf, parent).filter((b) => b.type === type)
}
