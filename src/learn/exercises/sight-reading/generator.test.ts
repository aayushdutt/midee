import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateNoteSource, MidiFileSource } from './generator'

function seq(values: readonly number[]): () => number {
  let i = 0
  return () => {
    const v = values[i % values.length]
    i++
    return v ?? 0
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('generateNoteSource', () => {
  it('never returns consecutive duplicate pitches', () => {
    const src = generateNoteSource({ pitchPool: [60, 62, 64, 65, 67], sessionLength: 200 })
    let prev: number | null = null
    for (let i = 0; i < 200; i++) {
      const pitch = src.next()
      expect(pitch).not.toBeNull()
      if (prev !== null) expect(pitch).not.toBe(prev)
      prev = pitch
    }
  })

  it('exhausts after sessionLength notes', () => {
    const src = generateNoteSource({ pitchPool: [60, 62, 64], sessionLength: 3 })
    expect(src.next()).not.toBeNull()
    expect(src.next()).not.toBeNull()
    expect(src.next()).not.toBeNull()
    expect(src.next()).toBeNull()
    expect(src.done).toBe(true)
    expect(src.progress).toBe(1)
  })

  it('Infinity session never exhausts, progress always 0', () => {
    const src = generateNoteSource({ pitchPool: [60, 62], sessionLength: Infinity })
    for (let i = 0; i < 100; i++) {
      expect(src.next()).not.toBeNull()
      expect(src.done).toBe(false)
      expect(src.progress).toBe(0)
    }
  })

  it('reports progress as fraction of sessionLength', () => {
    const src = generateNoteSource({ pitchPool: [60, 62, 64], sessionLength: 6 })
    expect(src.progress).toBe(0)
    src.next()
    expect(src.progress).toBeCloseTo(1 / 6)
    src.next()
    expect(src.progress).toBeCloseTo(2 / 6)
  })

  it('single-note pool: falls back to full pool (no crash)', () => {
    const src = generateNoteSource({ pitchPool: [60], sessionLength: 5 })
    for (let i = 0; i < 5; i++) {
      expect(src.next()).toBe(60)
    }
    expect(src.next()).toBeNull()
  })

  it('stepwise path: second note is within ±2 pool indices of the first', () => {
    // First call: no lastPitch, so stepwise is empty → Math.random NOT called.
    // Second call: lastPitch exists → two Math.random calls:
    //   1. stepwise check (need < 0.7)
    //   2. weighted pick
    vi.spyOn(Math, 'random').mockImplementation(seq([0.1, 0.5]))

    const pool = [60, 62, 64, 65, 67]
    const src = generateNoteSource({ pitchPool: pool, sessionLength: 2 })

    const first = src.next()!
    expect(pool).toContain(first)

    // Second call: lastPitch=first. First random 0.1 < 0.7 → stepwise path.
    // Stepwise candidates from first's index ±2 (excl. first itself).
    const firstIdx = pool.indexOf(first)
    const stepwiseRange = pool.slice(
      Math.max(0, firstIdx - 2),
      Math.min(pool.length, firstIdx + 3),
    ).filter((p) => p !== first)

    const second = src.next()!
    expect(stepwiseRange).toContain(second)
  })

  it('full-pool path: when Math.random >= 0.7, any non-dup note from pool is valid', () => {
    vi.spyOn(Math, 'random').mockImplementation(seq([0.0, 0.9, 0.5]))

    const pool = [60, 62, 64, 65, 67]
    const src = generateNoteSource({ pitchPool: pool, sessionLength: 2 })

    const first = src.next()!
    // Second call: random 0.9 >= 0.7 → full-pool path. Can be any note ≠ first.
    const second = src.next()!
    expect(second).not.toBe(first)
    expect(pool).toContain(second)
  })

  it('weakNoteFocus: focused note given 3× weight in weighted pick', () => {
    // Pool: [60, 64, 67]. Focus 64 = 3×, others = 1×. Total weight = 5.
    // r=0.5 → 5*0.5=2.5. i=0(60,w=1):2.5-1=1.5>0. i=1(64,w=3):1.5-3=-1.5≤0 → 64.
    vi.spyOn(Math, 'random').mockImplementation(seq([0.5]))

    const src = generateNoteSource({
      pitchPool: [60, 64, 67],
      sessionLength: 1,
      weakNoteFocus: [64],
    })
    expect(src.next()).toBe(64)
  })
})

describe('MidiFileSource', () => {
  it('plays back fixed note list in order', () => {
    const src = new MidiFileSource([60, 64, 67, 72])
    expect(src.next()).toBe(60)
    expect(src.next()).toBe(64)
    expect(src.next()).toBe(67)
    expect(src.next()).toBe(72)
    expect(src.next()).toBeNull()
    expect(src.done).toBe(true)
  })

  it('empty list: done immediately, progress = 1', () => {
    const src = new MidiFileSource([])
    expect(src.next()).toBeNull()
    expect(src.done).toBe(true)
    expect(src.progress).toBe(1)
  })

  it('progress reports correctly mid-sequence', () => {
    const src = new MidiFileSource([60, 64, 67])
    expect(src.progress).toBe(0)
    src.next() // 60
    expect(src.progress).toBeCloseTo(1 / 3)
    src.next() // 64
    expect(src.progress).toBeCloseTo(2 / 3)
    src.next() // 67
    expect(src.progress).toBe(1)
  })
})
