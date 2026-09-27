// Output-quality helpers for the `exportquality` bench suite (runner.ts):
// a seeded PRNG for bit-identical renders, luma extraction, PSNR / block SSIM,
// and an in-page MP4 inspector (Mediabunny demux + the browser's WebCodecs
// decoders — what a Chromium or WebKit <video> plays). Everything but
// inspectMp4 is pure and unit-tested (videoQuality.test.ts).
// See docs/EXPORT_PERF_MEASUREMENTS_2026-09-27.md ("Output quality").

// Mulberry32: tiny, fast, good enough to stand in for Math.random in the
// renderer's particle emission. Same seed → same sequence, every browser.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Runs `fn` with Math.random swapped for `random`, restoring it afterwards.
// Only the synchronous `fn` sees the swap, so concurrent async work (the
// offline audio render during an export) never consumes the seeded stream.
export function withRandom<T>(random: () => number, fn: () => T): T {
  const original = Math.random
  Math.random = random
  try {
    return fn()
  } finally {
    Math.random = original
  }
}

// Y' from RGBA with BT.709 weights (54/183/19 of 256), full range. Applied to
// BOTH sides of every comparison, so it's a fixed yardstick, not a claim about
// the encoder's own matrix — a mismatched matrix/range in the file shows up
// as PSNR loss and `bias`.
export function lumaFromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  out: Uint8Array = new Uint8Array(rgba.length >> 2),
): Uint8Array {
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (54 * rgba[p]! + 183 * rgba[p + 1]! + 19 * rgba[p + 2]! + 128) >> 8
  }
  return out
}

// PSNR in dB over two equal-length luma planes; 99 = identical (the e2e
// decode helper's convention).
export function psnr(a: Uint8Array, b: Uint8Array): number {
  let se = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!
    se += d * d
  }
  return se === 0 ? 99 : Math.min(99, 10 * Math.log10((255 * 255 * a.length) / se))
}

// Mean of (a − b): a systematic brightness shift (colour-range or matrix
// mismatch between encoder and decoder) rather than coding noise.
export function meanBias(a: Uint8Array, b: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! - b[i]!
  return sum / Math.max(1, a.length)
}

// SSIM over non-overlapping 8×8 blocks (standard constants, population
// variance), averaged. Cheaper than the Gaussian-window original and a little
// harsher on blocking; used only to compare configs with each other.
export function ssim(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const B = 8
  const N = B * B
  const C1 = (0.01 * 255) ** 2
  const C2 = (0.03 * 255) ** 2
  let total = 0
  let blocks = 0
  for (let by = 0; by + B <= height; by += B) {
    for (let bx = 0; bx + B <= width; bx += B) {
      let sa = 0
      let sb = 0
      let saa = 0
      let sbb = 0
      let sab = 0
      for (let y = 0; y < B; y++) {
        const row = (by + y) * width + bx
        for (let x = 0; x < B; x++) {
          const va = a[row + x]!
          const vb = b[row + x]!
          sa += va
          sb += vb
          saa += va * va
          sbb += vb * vb
          sab += va * vb
        }
      }
      const ma = sa / N
      const mb = sb / N
      const cov = sab / N - ma * mb
      const vara = saa / N - ma * ma
      const varb = sbb / N - mb * mb
      total +=
        ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (vara + varb + C2))
      blocks++
    }
  }
  return blocks === 0 ? 1 : total / blocks
}

export interface Mp4Report {
  // Structure (video packets in decode order).
  frames: number
  firstPtsMs: number
  ptsErrMaxMs: number // max |pts − i/fps| over decode order
  reorders: number // pts decreases in decode order: B-frame reordering
  keyframes: number
  keyOffCadence: number // frames whose key-ness disagrees with "every keyEvery"
  videoKbps: number // video packet bytes over frames / fps
  // Fidelity (decoded frames in presentation order vs the reference luma).
  sampled: number
  psnrMean: number
  psnrMin: number
  ssimMean: number
  ssimMin: number
  biasMean: number
  unmatched: number // reference frames with no decoded frame at their pts
  // Audio (null when the file has no audio track).
  audioKbps: number | null
  audioFirstPtsMs: number | null
  audioOnsetMs: number | null // first sample ≥ 10 % of the peak
}

// Demuxes and decodes an exported MP4 in the page. `refs` maps frame index →
// reference luma (width × height); a decoded frame is matched to index
// round(pts × fps), so a dropped or duplicated frame can't shift the scores.
export async function inspectMp4(
  blob: Blob,
  o: {
    fps: number
    keyEvery: number
    width: number
    height: number
    refs: Map<number, Uint8Array>
  },
): Promise<Mp4Report> {
  const M = await import('mediabunny')
  const input = new M.Input({ source: new M.BlobSource(blob), formats: M.ALL_FORMATS })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('exported MP4 has no video track')

    let frames = 0
    let bytes = 0
    let reorders = 0
    let keyframes = 0
    let keyOffCadence = 0
    let ptsErrMax = 0
    let firstPts = Number.NaN
    let prevPts = Number.NEGATIVE_INFINITY
    for await (const p of new M.EncodedPacketSink(video).packets()) {
      const i = frames++
      if (i === 0) firstPts = p.timestamp
      if (p.timestamp < prevPts) reorders++
      prevPts = p.timestamp
      ptsErrMax = Math.max(ptsErrMax, Math.abs(p.timestamp - i / o.fps))
      bytes += p.byteLength
      const key = p.type === 'key'
      if (key) keyframes++
      if (key !== (i % o.keyEvery === 0)) keyOffCadence++
    }

    const scratch = new OffscreenCanvas(o.width, o.height).getContext('2d', {
      willReadFrequently: true,
    })
    if (!scratch) throw new Error('no 2D context for decoded frames')
    const luma = new Uint8Array(o.width * o.height)
    const psnrs: number[] = []
    const ssims: number[] = []
    const biases: number[] = []
    const matched = new Set<number>()
    for await (const sample of new M.VideoSampleSink(video).samples()) {
      try {
        const index = Math.round(sample.timestamp * o.fps)
        const ref = o.refs.get(index)
        if (!ref || matched.has(index)) continue
        matched.add(index)
        sample.draw(scratch, 0, 0, o.width, o.height)
        lumaFromRgba(scratch.getImageData(0, 0, o.width, o.height).data, luma)
        psnrs.push(psnr(luma, ref))
        ssims.push(ssim(luma, ref, o.width, o.height))
        biases.push(meanBias(luma, ref))
      } finally {
        sample.close()
      }
    }

    let audioKbps: number | null = null
    let audioFirstPtsMs: number | null = null
    let audioOnsetMs: number | null = null
    const audio = await input.getPrimaryAudioTrack()
    if (audio) {
      const stats = await audio.computePacketStats()
      audioKbps = stats.averageBitrate / 1000
      const buffers: { buffer: AudioBuffer; timestamp: number }[] = []
      for await (const b of new M.AudioBufferSink(audio).buffers()) buffers.push(b)
      audioFirstPtsMs = buffers.length ? buffers[0]!.timestamp * 1000 : null
      let peak = 0
      for (const { buffer } of buffers) {
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          for (const x of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(x))
        }
      }
      search: for (const { buffer, timestamp } of buffers) {
        for (let s = 0; s < buffer.length; s++) {
          for (let c = 0; c < buffer.numberOfChannels; c++) {
            if (peak > 0 && Math.abs(buffer.getChannelData(c)[s]!) >= 0.1 * peak) {
              audioOnsetMs = (timestamp + s / buffer.sampleRate) * 1000
              break search
            }
          }
        }
      }
    }

    const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
    return {
      frames,
      firstPtsMs: firstPts * 1000,
      ptsErrMaxMs: ptsErrMax * 1000,
      reorders,
      keyframes,
      keyOffCadence,
      videoKbps: (bytes * 8) / (Math.max(1, frames) / o.fps) / 1000,
      sampled: psnrs.length,
      psnrMean: mean(psnrs),
      psnrMin: psnrs.length ? Math.min(...psnrs) : 0,
      ssimMean: mean(ssims),
      ssimMin: ssims.length ? Math.min(...ssims) : 0,
      biasMean: mean(biases),
      unmatched: o.refs.size - matched.size,
      audioKbps,
      audioFirstPtsMs,
      audioOnsetMs,
    }
  } finally {
    input.dispose()
  }
}
