import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MasterClock } from './MasterClock'

// MasterClock.prime() reaches into Tone's AudioContext (getContext().rawContext
// + start()). Time itself is driven by the injected now() seam, so we only need
// to neutralise prime()'s side effects here — never to source time from Tone.
const rawCtx = { state: 'running' as AudioContextState }
const toneStart = vi.fn(() => Promise.resolve())
vi.mock('tone', () => ({
  getContext: () => ({ rawContext: rawCtx }),
  start: () => toneStart(),
}))

// Mutable time source: tests advance `t` to simulate AudioContext.currentTime.
function makeClock(start = 0): { clock: MasterClock; set: (v: number) => void } {
  let t = start
  const clock = new MasterClock(() => t)
  return {
    clock,
    set: (v: number) => {
      t = v
    },
  }
}

beforeEach(() => {
  rawCtx.state = 'running'
  toneStart.mockClear()
})

describe('MasterClock currentTime formula', () => {
  it('returns _startOffset while paused regardless of clock time', () => {
    const { clock, set } = makeClock(0)
    expect(clock.currentTime).toBe(0)
    set(123)
    // Not playing → time is frozen at the start offset.
    expect(clock.currentTime).toBe(0)
  })

  it('reflects _startOffset + (ctxTime - startCtxTime) * speed while playing', () => {
    const { clock, set } = makeClock(10)
    clock.play() // anchors _startContextTime = 10, _startOffset = 0
    set(15)
    expect(clock.currentTime).toBeCloseTo(5, 10) // 0 + (15-10)*1
  })

  it('scales elapsed time by speed when playing', () => {
    const { clock, set } = makeClock(0)
    clock.speed = 2
    clock.play()
    set(3)
    expect(clock.currentTime).toBeCloseTo(6, 10) // (3-0)*2
  })

  it('honors a non-zero start offset (play from offset)', () => {
    const { clock, set } = makeClock(100)
    clock.seek(20) // _startOffset = 20
    clock.play() // anchors at ctx=100
    set(105)
    expect(clock.currentTime).toBeCloseTo(25, 10) // 20 + (105-100)*1
  })
})

describe('speed setter re-anchoring while playing', () => {
  it('does not jump time when speed changes mid-play (continuity)', () => {
    const { clock, set } = makeClock(0)
    clock.play()
    set(4) // currentTime = 4 at speed 1
    expect(clock.currentTime).toBeCloseTo(4, 10)

    clock.speed = 3 // re-anchors; must NOT cause a jump at the change instant
    expect(clock.currentTime).toBeCloseTo(4, 10)
  })

  it('applies the new rate going forward after a mid-play speed change', () => {
    const { clock, set } = makeClock(0)
    clock.play()
    set(4) // position 4
    clock.speed = 3 // anchor: offset=4, ctxStart=4
    set(6) // elapsed (6-4)*3 = 6 → position 10
    expect(clock.currentTime).toBeCloseTo(10, 10)
  })

  it('does not re-anchor when speed is set while paused', () => {
    const { clock, set } = makeClock(0)
    clock.seek(5)
    clock.speed = 2 // paused → no anchoring side effect
    clock.play() // anchors now at ctx=0, offset=5
    set(2)
    expect(clock.currentTime).toBeCloseTo(9, 10) // 5 + (2-0)*2
  })
})

describe('seek while playing', () => {
  it('re-anchors so the next read does not double-count elapsed time', () => {
    const { clock, set } = makeClock(0)
    clock.play()
    set(10) // currentTime would be 10
    expect(clock.currentTime).toBeCloseTo(10, 10)

    clock.seek(2) // jump back to position 2 at ctx=10
    expect(clock.currentTime).toBeCloseTo(2, 10) // no leftover 10s counted

    set(13) // 3s real elapsed since seek
    expect(clock.currentTime).toBeCloseTo(5, 10) // 2 + 3
  })

  it('clamps negative seek targets to 0', () => {
    const { clock } = makeClock(0)
    clock.seek(-5)
    expect(clock.currentTime).toBe(0)
  })

  it('seek while paused sets the offset but leaves it paused', () => {
    const { clock, set } = makeClock(0)
    clock.seek(7)
    expect(clock.playing).toBe(false)
    set(100)
    expect(clock.currentTime).toBe(7) // still frozen, no anchoring
  })

  it('emits to subscribers on seek', () => {
    const { clock } = makeClock(0)
    const listener = vi.fn()
    clock.subscribe(listener)
    clock.seek(3)
    expect(listener).toHaveBeenCalledWith(3)
  })
})

describe('pause / resume', () => {
  it('freezes currentTime at the paused position', () => {
    const { clock, set } = makeClock(0)
    clock.play()
    set(8)
    clock.pause()
    expect(clock.playing).toBe(false)
    set(50) // clock keeps moving but we are paused
    expect(clock.currentTime).toBeCloseTo(8, 10)
  })

  it('resumes from the paused position without counting paused time', () => {
    const { clock, set } = makeClock(0)
    clock.play()
    set(8)
    clock.pause() // offset frozen at 8
    set(20) // 12s pass while paused — must NOT be counted
    clock.play() // re-anchors at ctx=20
    set(23) // 3s since resume
    expect(clock.currentTime).toBeCloseTo(11, 10) // 8 + 3
  })

  it('play() is idempotent while already playing', () => {
    const { clock, set } = makeClock(0)
    clock.play()
    set(5) // position 5, anchor at ctx=0
    clock.play() // no-op: must not re-anchor and reset position
    expect(clock.currentTime).toBeCloseTo(5, 10)
  })

  it('pause() is a no-op when already paused', () => {
    const { clock } = makeClock(0)
    expect(() => clock.pause()).not.toThrow()
    expect(clock.playing).toBe(false)
  })

  it('primes Tone via start() when the raw context is suspended', () => {
    rawCtx.state = 'suspended'
    const { clock } = makeClock(0)
    clock.play()
    expect(toneStart).toHaveBeenCalledTimes(1)
  })

  it('does not call Tone start() when context already running', () => {
    rawCtx.state = 'running'
    const { clock } = makeClock(0)
    clock.play()
    expect(toneStart).not.toHaveBeenCalled()
  })
})

describe('subscribe / unsubscribe / dispose', () => {
  it('fans out emissions to all subscribers', () => {
    const { clock } = makeClock(0)
    const a = vi.fn()
    const b = vi.fn()
    clock.subscribe(a)
    clock.subscribe(b)
    clock.seek(1)
    expect(a).toHaveBeenCalledWith(1)
    expect(b).toHaveBeenCalledWith(1)
  })

  it('unsubscribe stops further emissions to that listener', () => {
    const { clock } = makeClock(0)
    const listener = vi.fn()
    const off = clock.subscribe(listener)
    clock.seek(1)
    off()
    clock.seek(2)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith(1)
  })

  it('dispose pauses and clears all listeners', () => {
    const { clock, set } = makeClock(0)
    const listener = vi.fn()
    clock.subscribe(listener)
    clock.play()
    set(5)
    clock.dispose()
    expect(clock.playing).toBe(false)
    listener.mockClear()
    clock.seek(9) // no listeners remain → no emission
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('rAF tick emission', () => {
  // play() drives emission via requestAnimationFrame. jsdom provides rAF but it
  // is async; use fake timers so we can deterministically flush one frame and
  // assert the tick fires with the correct computed time.
  it('emits the current time on each animation frame while playing', () => {
    vi.useFakeTimers()
    try {
      const { clock, set } = makeClock(0)
      const listener = vi.fn()
      clock.subscribe(listener)
      clock.play() // immediate tick() emits 0, then schedules rAF
      expect(listener).toHaveBeenLastCalledWith(0)

      set(2)
      vi.advanceTimersByTime(16) // flush ~one rAF frame
      expect(listener).toHaveBeenLastCalledWith(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops scheduling frames after pause', () => {
    vi.useFakeTimers()
    try {
      const { clock, set } = makeClock(0)
      const listener = vi.fn()
      clock.subscribe(listener)
      clock.play()
      clock.pause()
      listener.mockClear()
      set(5)
      vi.advanceTimersByTime(64) // several frames
      expect(listener).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
