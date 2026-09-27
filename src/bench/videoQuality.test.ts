import { describe, expect, it } from 'vitest'
import { lumaFromRgba, meanBias, mulberry32, psnr, ssim, withRandom } from './videoQuality'

describe('mulberry32', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const xs = Array.from({ length: 1000 }, () => a())
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()))
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...xs)).toBeLessThan(1)
    expect(mulberry32(43)()).not.toBe(mulberry32(42)())
  })
})

describe('withRandom', () => {
  it('swaps Math.random only for the call, and restores it on throw', () => {
    const original = Math.random
    expect(
      withRandom(
        () => 0.25,
        () => Math.random(),
      ),
    ).toBe(0.25)
    expect(Math.random).toBe(original)
    expect(() =>
      withRandom(
        () => 0.5,
        () => {
          throw new Error('boom')
        },
      ),
    ).toThrow('boom')
    expect(Math.random).toBe(original)
  })
})

describe('lumaFromRgba', () => {
  it('maps black/white/grey and weights green heaviest', () => {
    const px = new Uint8Array([
      0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 0, 255, 0, 255,
    ])
    const y = lumaFromRgba(px)
    expect([...y.slice(0, 3)]).toEqual([0, 255, 128])
    expect(y[3]).toBe(182) // 183·255/256
  })
})

describe('psnr / meanBias / ssim', () => {
  const w = 16
  const h = 16
  const base = Uint8Array.from({ length: w * h }, (_, i) => (i * 37) % 256)

  it('identical planes: 99 dB, zero bias, SSIM 1', () => {
    expect(psnr(base, base)).toBe(99)
    expect(meanBias(base, base)).toBe(0)
    expect(ssim(base, base, w, h)).toBeCloseTo(1, 10)
  })

  it('a uniform +1 shift: 48.13 dB, bias 1', () => {
    const shifted = base.map((v) => Math.min(255, v + 1))
    const diff = shifted.reduce((n, v, i) => n + (v - base[i]!) ** 2, 0)
    expect(psnr(shifted, base)).toBeCloseTo(10 * Math.log10((255 * 255 * base.length) / diff), 10)
    expect(meanBias(shifted, base)).toBeGreaterThan(0.9)
  })

  it('SSIM drops with structure loss but not with small noise', () => {
    const flat = new Uint8Array(w * h).fill(128)
    const noisy = base.map((v, i) => v + (i % 2 ? 1 : -1) * (v > 0 && v < 255 ? 1 : 0))
    expect(ssim(noisy, base, w, h)).toBeGreaterThan(0.99)
    expect(ssim(flat, base, w, h)).toBeLessThan(0.1)
  })
})
