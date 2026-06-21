import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MasterClock } from '../core/clock/MasterClock'
import { fakeAudioContext } from '../test/fakeAudioContext'
import { LiveLooper, LOOKAHEAD_SEC, type LoopCallbacks, POLL_INTERVAL_MS } from './LiveLooper'

// LiveLooper sources ALL of its time from Tone's `getContext().currentTime`
// (see LiveLooper.ts: capture, finishBaseRecording, cyclePosNow, schedulePoll,
// undo, releaseAllSounding). We mock the `tone` module to hand back one shared,
// settable fake context so tests advance virtual audio time by assignment.
//
// `vi.mock` is hoisted above imports, so the context must live in a hoisted
// holder; `getContext` reads `.ctx` lazily on every call (LiveLooper calls
// getContext() many times per tick, and must see the latest currentTime).
const holder = vi.hoisted(() => ({ ctx: null as ReturnType<typeof fakeAudioContext> | null }))
vi.mock('tone', () => ({
  getContext: () => holder.ctx,
}))

// Minimal MasterClock stand-in — LiveLooper only stores it and never reads it
// (the `_clock` ctor param is unused; time comes from getContext()).
const fakeClock = {} as unknown as MasterClock

interface Harness {
  looper: LiveLooper
  cbs: { onPlaybackNoteOn: ReturnType<typeof vi.fn>; onPlaybackNoteOff: ReturnType<typeof vi.fn> }
  /** Set virtual AudioContext time. */
  setTime: (t: number) => void
  /** Advance virtual time AND run the poll loop so the scheduler catches up. */
  advanceTo: (t: number) => void
}

function makeHarness(quantize?: (raw: number) => number): Harness {
  const ctx = fakeAudioContext(0)
  holder.ctx = ctx
  const cbs: Harness['cbs'] = { onPlaybackNoteOn: vi.fn(), onPlaybackNoteOff: vi.fn() }
  const looper = new LiveLooper(fakeClock, cbs as LoopCallbacks, quantize)
  const setTime = (t: number) => {
    ctx.currentTime = t
  }
  // The scheduler is a setTimeout poll loop. To simulate the passage of time we
  // bump the virtual audio clock then let the (faked) poll timer fire so the
  // scheduler re-evaluates the lookahead horizon at the new time.
  const advanceTo = (t: number) => {
    setTime(t)
    // One poll covers the new horizon; flush any pending poll callbacks.
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
  }
  return { looper, cbs, setTime, advanceTo }
}

/** Record a base loop: arm → first note-on at t=0 → notes → tap stop at `stopAt`. */
function recordBaseLoop(
  h: Harness,
  events: Array<{ type: 'on' | 'off'; pitch: number; velocity?: number; at: number }>,
  stopAt: number,
): void {
  h.looper.toggle() // idle → armed
  for (const e of events) {
    h.setTime(e.at)
    if (e.type === 'on') h.looper.captureNoteOn(e.pitch, e.velocity ?? 100, 0)
    else h.looper.captureNoteOff(e.pitch, 0)
  }
  h.setTime(stopAt)
  h.looper.toggle() // recording → playing (anchors loopStartCtxTime = stopAt)
}

/** All onPlaybackNoteOn calls as [pitch, velocity, ctxTime]. */
function onCalls(h: Harness): Array<[number, number, number]> {
  return h.cbs.onPlaybackNoteOn.mock.calls as Array<[number, number, number]>
}
/** All onPlaybackNoteOff calls as [pitch, ctxTime]. */
function offCalls(h: Harness): Array<[number, number]> {
  return h.cbs.onPlaybackNoteOff.mock.calls as Array<[number, number]>
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
  holder.ctx = null
})

describe('LiveLooper state machine (toggle)', () => {
  it('walks idle → armed → recording → playing → overdubbing → playing', () => {
    const h = makeHarness()
    expect(h.looper.state.value).toBe('idle')

    h.looper.toggle()
    expect(h.looper.state.value).toBe('armed')

    h.setTime(0)
    h.looper.captureNoteOn(60, 100, 0) // first note flips armed → recording
    expect(h.looper.state.value).toBe('recording')

    h.setTime(1)
    h.looper.captureNoteOff(60, 0)
    h.setTime(2)
    h.looper.toggle() // recording → playing
    expect(h.looper.state.value).toBe('playing')
    expect(h.looper.layerCount.value).toBe(1)

    h.looper.toggle() // playing → overdubbing
    expect(h.looper.state.value).toBe('overdubbing')

    h.looper.toggle() // overdubbing (empty) → playing
    expect(h.looper.state.value).toBe('playing')
  })

  it('armed toggle with no notes cancels back to idle', () => {
    const h = makeHarness()
    h.looper.toggle() // → armed
    h.looper.toggle() // armed → idle (cancelArm)
    expect(h.looper.state.value).toBe('idle')
  })

  it('first captured note-on transitions armed → recording and is buffered', () => {
    const h = makeHarness()
    h.looper.toggle() // → armed
    h.setTime(0)
    h.looper.captureNoteOn(60, 100, 0) // armed → recording, buffers 1 event
    expect(h.looper.state.value).toBe('recording')
  })
})

describe('record → play (first cycle playback)', () => {
  it('replays recorded events at loopStart + their captured offsets', () => {
    const h = makeHarness()
    // Note 60 from t=0..1 within a 2s loop; loopStart anchored at ctx=2.
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 60, velocity: 90, at: 0 },
        { type: 'off', pitch: 60, at: 1 },
      ],
      2,
    )
    expect(h.looper.state.value).toBe('playing')
    // loopStartCtxTime = 2, loopDuration = 2.

    // startSchedulers ran at finishBaseRecording (ctx=2). Horizon = 2 + 0.15.
    // Only the on@0 (when=2.0) is < horizon; off@1 (when=3.0) is not yet.
    const ons = onCalls(h)
    expect(ons).toEqual([[60, 90, 2.0]])
    expect(offCalls(h)).toEqual([])

    // Advance so off@1 (when=3.0) enters the horizon.
    h.advanceTo(2.9) // horizon 3.05 ≥ 3.0
    expect(offCalls(h)).toEqual([[60, 3.0]])
    // No new ons in cycle 0 (next on is cycle 1 @ when=4.0, horizon 3.05).
    expect(onCalls(h)).toEqual([[60, 90, 2.0]])
  })

  it('schedules nothing until the scheduler starts, then exactly the in-horizon events', () => {
    const h = makeHarness()
    // NOTE: recordStartCtxTime anchors to the FIRST note-on. So a note captured
    // late in the loop still has a relative `time` measured from the first note.
    // Here the first (and only) note is at ctx=0.5 → it becomes the loop's t=0.
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 64, velocity: 70, at: 0.5 }, // relative time = 0
        { type: 'off', pitch: 64, at: 0.6 }, // relative time = 0.1
      ],
      1, // tap-stop at ctx=1 → loopDuration = 1-0.5 = 0.5, loopStart = 1
    )
    // on@rel0 → when=1.0 (within start horizon 1.15) fires immediately.
    expect(onCalls(h)).toEqual([[64, 70, 1.0]])
    // off@rel0.1 → when=1.1 also within horizon 1.15.
    expect(offCalls(h)).toEqual([[64, 1.1]])
  })
})

describe('cycle wrap (schedulePoll cursor idx >= length → cycle++)', () => {
  it('re-fires events one loopDuration later on the next cycle', () => {
    const h = makeHarness()
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 60, velocity: 100, at: 0 },
        { type: 'off', pitch: 60, at: 0.5 },
      ],
      1, // loopDuration = 1, loopStart = 1
    )
    // Cycle 0: on@when=1.0 (in start horizon 1.15), off@when=1.5 (not yet).
    expect(onCalls(h)).toEqual([[60, 100, 1.0]])

    h.advanceTo(1.5) // horizon 1.65: off cycle0 @1.5 fires
    expect(offCalls(h).map((c) => c[1])).toContain(1.5)

    // Advance into cycle 1: on should re-fire at when = loopStart + 1*dur + 0 = 2.0
    h.advanceTo(1.9) // horizon 2.05 ≥ 2.0
    const onTimes = onCalls(h).map((c) => c[2])
    expect(onTimes).toContain(2.0) // cycle 1 on
    expect(onTimes).toEqual([1.0, 2.0])

    // And cycle 1 off at 2.5.
    h.advanceTo(2.4) // horizon 2.55 ≥ 2.5
    expect(offCalls(h).map((c) => c[1])).toContain(2.5)
  })

  it('handles multiple cycles wrapping with correct cumulative offsets', () => {
    const h = makeHarness()
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 72, velocity: 80, at: 0 },
        { type: 'off', pitch: 72, at: 0.2 },
      ],
      0.5, // short loop → many wraps; loopStart = 0.5
    )
    // Drive forward to cover cycles 0..3.
    for (let t = 0.5; t <= 2.5; t += POLL_INTERVAL_MS / 1000) {
      h.advanceTo(t)
    }
    // Expected on times: loopStart(0.5) + cycle*0.5 + 0 → 0.5, 1.0, 1.5, 2.0, 2.5...
    const onTimes = onCalls(h).map((c) => c[2])
    // Strictly increasing by exactly loopDuration, no duplicates, no gaps.
    for (let i = 1; i < onTimes.length; i++) {
      expect(onTimes[i]! - onTimes[i - 1]!).toBeCloseTo(0.5, 6)
    }
    expect(onTimes[0]).toBeCloseTo(0.5, 6)
    // Every on (except possibly the final one whose off hasn't entered the
    // horizon yet) has a matching off exactly 0.2 later.
    const offTimes = offCalls(h).map((c) => c[1])
    for (const on of onTimes.slice(0, -1)) {
      expect(offTimes.some((o) => Math.abs(o - (on + 0.2)) < 1e-6)).toBe(true)
    }
  })
})

describe('closeOrphans (dangling note-on gets a synthesized off)', () => {
  it('synthesizes an off at loopDuration for an unmatched note-on', () => {
    const h = makeHarness()
    // Record only a note-ON, never released. Loop = 2s.
    recordBaseLoop(h, [{ type: 'on', pitch: 60, velocity: 100, at: 0 }], 2)

    // snapshot exposes the committed layer; the orphan-off must have been added.
    const snap = h.looper.snapshot()
    expect(snap.duration).toBe(2)
    const offs = snap.events.filter((e) => e.type === 'off')
    expect(offs).toHaveLength(1)
    expect(offs[0]).toMatchObject({ type: 'off', pitch: 60, time: 2 })

    // And during playback the synthesized off actually fires (no stuck note).
    expect(onCalls(h)).toEqual([[60, 100, 2.0]]) // on @ loopStart
    h.advanceTo(3.9) // off when = loopStart(2) + 0 + 2(dur) = 4.0; horizon 4.05
    expect(offCalls(h)).toContainEqual([60, 4.0])
  })

  it('pairs the right number of offs when multiple ons of the same pitch are open', () => {
    const h = makeHarness()
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 67, velocity: 100, at: 0 },
        { type: 'on', pitch: 67, velocity: 110, at: 0.5 }, // second on, only one off
        { type: 'off', pitch: 67, at: 1 },
      ],
      2,
    )
    const snap = h.looper.snapshot()
    const offs = snap.events.filter((e) => e.type === 'off')
    // One natural off @1, one synthesized orphan-off @ loopDuration (2).
    expect(offs).toHaveLength(2)
    expect(offs.some((e) => e.time === 1)).toBe(true)
    expect(offs.some((e) => e.time === 2)).toBe(true)
  })
})

describe('overdub (cursor placement via firstIndexAtOrAfter)', () => {
  it('captures overdub events at cyclePosNow and starts the cursor from there', () => {
    const h = makeHarness()
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 60, velocity: 100, at: 0 },
        { type: 'off', pitch: 60, at: 1.8 },
      ],
      2, // loopStart = 2, loopDuration = 2
    )
    h.cbs.onPlaybackNoteOn.mockClear()
    h.cbs.onPlaybackNoteOff.mockClear()

    // Enter overdub mid-loop. At ctx=3 → elapsed=1 → cyclePos=1.0 (cycle 0).
    h.setTime(3)
    h.looper.toggle() // playing → overdubbing
    expect(h.looper.state.value).toBe('overdubbing')

    // Overdub a note at cyclePos 1.0 .. 1.5.
    h.setTime(3) // pos = 1.0
    h.looper.captureNoteOn(64, 90, 0)
    h.setTime(3.5) // pos = 1.5
    h.looper.captureNoteOff(64, 0)

    // Commit at ctx=3.5 → cycle 0, pos 1.5. The new layer's cursor starts at the
    // first event with time >= 1.5, i.e. the off@1.5 (idx of on@1.0 is skipped
    // because it's "before here").
    h.looper.toggle() // overdubbing → playing
    expect(h.looper.state.value).toBe('playing')
    expect(h.looper.layerCount.value).toBe(2)

    // The committed overdub layer holds on@1.0 and off@1.5.
    const layer = h.looper.snapshot().events
    expect(layer.some((e) => e.type === 'on' && e.pitch === 64 && e.time === 1.0)).toBe(true)
    expect(layer.some((e) => e.type === 'off' && e.pitch === 64 && e.time === 1.5)).toBe(true)

    // Because the cursor starts at idx of off@1.5, the next scheduled overdub
    // event is the off (the on@1.0 is skipped this cycle). Advance to it:
    // when = loopStart(2) + cycle0*2 + 1.5 = 3.5; horizon needs ≥ 3.5.
    h.advanceTo(3.4) // horizon 3.55 ≥ 3.5
    // No overdub note-ON should have fired yet for pitch 64 in this cycle.
    const ons64ThisCycle = onCalls(h).filter((c) => c[0] === 64 && c[2] < 4)
    expect(ons64ThisCycle).toEqual([])
    // The skipped-cursor off DOES fire (stuck-note guard for partial overdub).
    expect(offCalls(h).some((c) => c[0] === 64 && Math.abs(c[1] - 3.5) < 1e-6)).toBe(true)

    // Next cycle, the overdub on@1.0 fires at when = loopStart + 1*2 + 1.0 = 5.0.
    h.advanceTo(4.9) // horizon 5.05 ≥ 5.0
    expect(onCalls(h).some((c) => c[0] === 64 && Math.abs(c[2] - 5.0) < 1e-6)).toBe(true)
  })

  it('committing an empty overdub just returns to playing without a new layer', () => {
    const h = makeHarness()
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 60, velocity: 100, at: 0 },
        { type: 'off', pitch: 60, at: 0.5 },
      ],
      1,
    )
    h.looper.toggle() // → overdubbing
    h.looper.toggle() // → playing (empty)
    expect(h.looper.state.value).toBe('playing')
    expect(h.looper.layerCount.value).toBe(1)
  })
})

describe('undo() fires offs for sounding notes of removed layer (no stuck notes)', () => {
  it('emits a note-off for a pitch the popped layer was mid-note on', () => {
    const h = makeHarness()
    // Base layer.
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 60, velocity: 100, at: 0 },
        { type: 'off', pitch: 60, at: 1.8 },
      ],
      2,
    )

    // Overdub a long note that will be sounding when we undo.
    h.setTime(2) // pos 0 (cycle 0)
    h.looper.toggle() // → overdubbing
    h.setTime(2) // pos 0
    h.looper.captureNoteOn(67, 100, 0)
    h.setTime(3.9) // pos ~1.9
    h.looper.captureNoteOff(67, 0)
    h.setTime(2) // commit back near loop start → cursor at idx 0 (pos≈0)
    h.looper.toggle() // commit → playing, layerCount 2

    expect(h.looper.layerCount.value).toBe(2)

    // Drive the scheduler so the overdub on@0 fires and is recorded as sounding.
    h.advanceTo(2.0)
    expect(onCalls(h).some((c) => c[0] === 67)).toBe(true)

    h.cbs.onPlaybackNoteOff.mockClear()
    // Undo while 67 is still sounding (its off@1.9 → when 3.9 not yet scheduled).
    h.setTime(2.5)
    h.looper.undo()

    expect(h.looper.layerCount.value).toBe(1)
    // The popped layer's sounding pitch 67 must get an explicit off at ctx now.
    expect(offCalls(h)).toContainEqual([67, 2.5])
  })

  it('undo with a single layer clears everything (and releases sounding notes)', () => {
    const h = makeHarness()
    // Single layer with an orphan note that is sounding at undo time.
    recordBaseLoop(h, [{ type: 'on', pitch: 62, velocity: 100, at: 0 }], 2)
    h.advanceTo(2.0) // fire the on → 62 sounding
    expect(onCalls(h).some((c) => c[0] === 62)).toBe(true)

    h.cbs.onPlaybackNoteOff.mockClear()
    h.setTime(2.3)
    h.looper.undo() // layers.length <= 1 → clear()
    expect(h.looper.state.value).toBe('idle')
    expect(h.looper.layerCount.value).toBe(0)
    // clear() → releaseAllSounding() emits off for 62.
    expect(offCalls(h)).toContainEqual([62, 2.3])
  })

  it('undo during overdub drops the pending overdub and returns to playing', () => {
    const h = makeHarness()
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 60, velocity: 100, at: 0 },
        { type: 'off', pitch: 60, at: 0.5 },
      ],
      1,
    )
    h.looper.toggle() // → overdubbing
    h.setTime(1)
    h.looper.captureNoteOn(64, 90, 0) // buffered pending overdub
    h.looper.undo() // overdubbing → playing, pendingOverdub cleared
    expect(h.looper.state.value).toBe('playing')
    expect(h.looper.layerCount.value).toBe(1) // no new layer committed
  })
})

describe('clear() releases sounding notes and resets state', () => {
  it('emits offs for all currently sounding pitches', () => {
    const h = makeHarness()
    recordBaseLoop(h, [{ type: 'on', pitch: 65, velocity: 100, at: 0 }], 2)
    h.advanceTo(2.0) // 65 sounding
    h.cbs.onPlaybackNoteOff.mockClear()

    h.setTime(2.7)
    h.looper.clear()
    expect(offCalls(h)).toContainEqual([65, 2.7])
    expect(h.looper.state.value).toBe('idle')
    expect(h.looper.layerCount.value).toBe(0)
    expect(h.looper.snapshot()).toEqual({ events: [], duration: 0 })
  })
})

describe('cyclePosNow modulo correctness at boundaries', () => {
  // cyclePosNow is private; we observe it indirectly via overdub capture, which
  // stamps the event `time` with cyclePosNow().
  function overdubPosAt(loopDuration: number, ctxAtCommit: number): number {
    const h = makeHarness()
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 60, velocity: 100, at: 0 },
        { type: 'off', pitch: 60, at: loopDuration * 0.9 },
      ],
      loopDuration, // loopStart = loopDuration
    )
    h.looper.toggle() // → overdubbing
    h.setTime(ctxAtCommit)
    h.looper.captureNoteOn(80, 100, 0) // stamps time = cyclePosNow()
    const layerThenPending = h.looper
    // Read back the pending event time by committing and inspecting snapshot.
    h.setTime(ctxAtCommit)
    h.looper.captureNoteOff(80, 0)
    layerThenPending.toggle() // commit
    const ev = h.looper.snapshot().events.find((e) => e.pitch === 80 && e.type === 'on')
    return ev!.time
  }

  it('pos at exact loop start (elapsed=0) is 0', () => {
    // loopStart = 2, commit at ctx=2 → elapsed 0 → pos 0.
    expect(overdubPosAt(2, 2)).toBeCloseTo(0, 6)
  })

  it('pos mid-cycle equals elapsed within the cycle', () => {
    // loopStart = 2, commit at ctx=3.5 → elapsed 1.5, dur 2 → pos 1.5.
    expect(overdubPosAt(2, 3.5)).toBeCloseTo(1.5, 6)
  })

  it('wraps at exactly one full loop (elapsed = loopDuration → pos 0)', () => {
    // loopStart = 2, dur 2, commit at ctx=4 → elapsed 2 → 2 mod 2 = 0.
    expect(overdubPosAt(2, 4)).toBeCloseTo(0, 6)
  })

  it('wraps into the second cycle (elapsed > loopDuration)', () => {
    // loopStart = 2, dur 2, commit at ctx=5 → elapsed 3 → 3 mod 2 = 1.
    expect(overdubPosAt(2, 5)).toBeCloseTo(1, 6)
  })
})

describe('dispose stops the scheduler (no further callbacks after disposal)', () => {
  it('stops firing scheduled events once disposed', () => {
    const h = makeHarness()
    recordBaseLoop(
      h,
      [
        { type: 'on', pitch: 60, velocity: 100, at: 0 },
        { type: 'off', pitch: 60, at: 0.5 },
      ],
      1,
    )
    const onsBefore = onCalls(h).length
    h.looper.dispose()
    h.advanceTo(5.0) // would normally fire many cycles
    expect(onCalls(h).length).toBe(onsBefore)
  })
})

// Sanity guard: many tests below hard-code horizon arithmetic (e.g. advanceTo
// timings) assuming these source constants. Imported from LiveLooper.ts (not
// copied), so if either changes the timing tests fail loudly here first.
describe('test assumptions', () => {
  it('source lookahead/poll constants still match the values the tests assume', () => {
    expect(LOOKAHEAD_SEC).toBe(0.15)
    expect(POLL_INTERVAL_MS).toBe(25)
  })
})
