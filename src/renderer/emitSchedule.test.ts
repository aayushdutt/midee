import { describe, expect, it } from 'vitest'
import { type EmitCadence, scheduleEmissions } from './emitSchedule'

// Mirrors the renderer's SUSTAIN_INITIAL_DELAY_SEC / SUSTAIN_INTERVAL_SEC.
const CADENCE: EmitCadence = { initialDelaySec: 0.18, intervalSec: 0.14 }

const set = (...keys: number[]) => new Set(keys)

describe('scheduleEmissions', () => {
  it('first frame (empty prev) treats every active key as a note-on', () => {
    const schedule = new Map<number, number>()
    const { emits, reaped } = scheduleEmissions({
      prev: set(),
      curr: set(10, 20),
      schedule,
      currentTime: 1,
      cadence: CADENCE,
    })

    expect(emits).toEqual([
      { key: 10, kind: 'onset' },
      { key: 20, kind: 'onset' },
    ])
    expect(reaped).toEqual([])
    // First sustained puff is scheduled one initial-delay out.
    expect(schedule.get(10)).toBeCloseTo(1.18)
    expect(schedule.get(20)).toBeCloseTo(1.18)
  })

  it('emits onset only for keys newly active vs prev', () => {
    const schedule = new Map<number, number>([[10, 1.18]])
    const { emits } = scheduleEmissions({
      prev: set(10),
      curr: set(10, 30), // 30 is new this frame
      schedule,
      currentTime: 1.1,
      cadence: CADENCE,
    })

    // 10 was held and its puff isn't due yet (1.1 < 1.18) → no event.
    // 30 is a fresh note-on.
    expect(emits).toEqual([{ key: 30, kind: 'onset' }])
    expect(schedule.get(30)).toBeCloseTo(1.28)
  })

  it('held note emits a sustain puff once the scheduled interval arrives, then reschedules', () => {
    const schedule = new Map<number, number>([[10, 1.18]])

    // Before the puff is due: nothing.
    let res = scheduleEmissions({
      prev: set(10),
      curr: set(10),
      schedule,
      currentTime: 1.1,
      cadence: CADENCE,
    })
    expect(res.emits).toEqual([])
    expect(schedule.get(10)).toBeCloseTo(1.18)

    // At/after the scheduled time: a sustain puff fires, next one is +interval.
    res = scheduleEmissions({
      prev: set(10),
      curr: set(10),
      schedule,
      currentTime: 1.18,
      cadence: CADENCE,
    })
    expect(res.emits).toEqual([{ key: 10, kind: 'sustain' }])
    expect(schedule.get(10)).toBeCloseTo(1.32) // 1.18 + 0.14
  })

  it('sustains at the configured cadence across several frames', () => {
    const schedule = new Map<number, number>()
    // Onset at t=0.
    scheduleEmissions({ prev: set(), curr: set(5), schedule, currentTime: 0, cadence: CADENCE })
    expect(schedule.get(5)).toBeCloseTo(0.18)

    const sustains: number[] = []
    // Step time forward in fine ticks; record each sustain puff time.
    for (let i = 1; i <= 30; i++) {
      const t = Number((i * 0.02).toFixed(2))
      const r = scheduleEmissions({
        prev: set(5),
        curr: set(5),
        schedule,
        currentTime: t,
        cadence: CADENCE,
      })
      if (r.emits.some((e) => e.kind === 'sustain')) sustains.push(t)
    }
    // First puff at the first tick >= 0.18, then ~every interval (0.14s) apart.
    expect(sustains[0]).toBeCloseTo(0.18)
    expect(sustains.length).toBeGreaterThanOrEqual(3)
    for (let k = 1; k < sustains.length; k++) {
      // Consecutive puffs are roughly one interval apart (allow one tick of
      // quantization slack since puffs only fire on a tick at/after due time).
      const gap = sustains[k]! - sustains[k - 1]!
      expect(gap).toBeGreaterThanOrEqual(0.14)
      expect(gap).toBeLessThanOrEqual(0.14 + 0.02 + 1e-9)
    }
  })

  it('reaps schedule entries for notes that turned off', () => {
    const schedule = new Map<number, number>([
      [10, 1.18],
      [20, 1.18],
    ])
    const { emits, reaped } = scheduleEmissions({
      prev: set(10, 20),
      curr: set(10), // 20 turned off
      schedule,
      currentTime: 1.1,
      cadence: CADENCE,
    })

    expect(emits).toEqual([]) // 10 not due yet
    expect(reaped).toEqual([20])
    expect(schedule.has(20)).toBe(false)
    expect(schedule.has(10)).toBe(true)
  })

  it('does not leak the prev/curr state across frames (no double note-on)', () => {
    const schedule = new Map<number, number>()
    // Frame 1: onset.
    let prev = set()
    let curr = set(7)
    let r = scheduleEmissions({ prev, curr, schedule, currentTime: 0, cadence: CADENCE })
    expect(r.emits).toEqual([{ key: 7, kind: 'onset' }])

    // Swap prev<-curr as the renderer does, then render the same held note.
    prev = curr
    curr = set(7)
    r = scheduleEmissions({ prev, curr, schedule, currentTime: 0.05, cadence: CADENCE })
    // No second onset — it's held now, and not yet due for a sustain.
    expect(r.emits).toEqual([])
  })

  describe('emit-eligibility (beforeFirstPlay / practice gate)', () => {
    it('suppresses all emission when no key is eligible (e.g. beforeFirstPlay / paused static frame)', () => {
      // The renderer only adds keys to `eligible` when particles are enabled and
      // the note isn't practice-gated. An empty eligible set with active `curr`
      // means highlight-only: no bursts, but schedule reaping still runs.
      const schedule = new Map<number, number>()
      const { emits, reaped } = scheduleEmissions({
        prev: set(),
        curr: set(10, 20),
        eligible: set(),
        schedule,
        currentTime: 0,
        cadence: CADENCE,
      })
      expect(emits).toEqual([])
      expect(reaped).toEqual([])
      // No schedule entries created for highlight-only keys.
      expect(schedule.size).toBe(0)
    })

    it('emits only for eligible keys but still reaps based on the full active set', () => {
      // Key 30 is highlight-active (in curr) but NOT eligible to emit — e.g. its
      // track went practice-inactive this frame. Its existing schedule entry
      // must NOT be reaped (it's still in curr), and it must not emit.
      const schedule = new Map<number, number>([
        [30, 1.18],
        [40, 1.18], // 40 turned off entirely → reaped
      ])
      const { emits, reaped } = scheduleEmissions({
        prev: set(30, 40), // 10 is a fresh onset this frame
        curr: set(10, 30), // 40 off; 30 still highlight-active but gated
        eligible: set(10), // only 10 may emit
        schedule,
        currentTime: 1.0,
        cadence: CADENCE,
      })

      expect(emits).toEqual([{ key: 10, kind: 'onset' }])
      expect(reaped).toEqual([40])
      expect(schedule.has(30)).toBe(true) // not reaped — still in curr
      expect(schedule.has(40)).toBe(false)
    })
  })
})
