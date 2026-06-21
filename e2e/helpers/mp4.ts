// Minimal, dependency-free ISO-BMFF (MP4) inspector for e2e assertions.
//
// We deliberately avoid pulling Mediabunny into the Node test process — the app
// already produces the file; here we only need to PROVE it is a structurally valid
// MP4 with the expected tracks and duration. Parsing top-level + a couple of nested
// boxes is enough and has zero runtime dependencies, so it can't drift from the app.
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

function childBoxes(buf: Uint8Array, parent: Mp4Box): Mp4Box[] {
  const slice = buf.subarray(parent.payloadStart, parent.payloadStart + parent.payloadSize)
  return parseTopLevelBoxes(slice).map((b) => ({
    ...b,
    start: b.start + parent.payloadStart,
    payloadStart: b.payloadStart + parent.payloadStart,
  }))
}

function findChild(buf: Uint8Array, parent: Mp4Box, type: string): Mp4Box | undefined {
  return childBoxes(buf, parent).find((b) => b.type === type)
}

function findChildren(buf: Uint8Array, parent: Mp4Box, type: string): Mp4Box[] {
  return childBoxes(buf, parent).filter((b) => b.type === type)
}
