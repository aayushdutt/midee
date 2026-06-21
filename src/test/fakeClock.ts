// Shared fake clock for unit tests. Mirrors the subscribe/emit shape that
// PracticeEngine.test.ts and the MasterClock-consuming engine tests hand-roll:
//
//   - `subscribe(fn)` registers a listener and returns an unsubscribe fn.
//   - `emit(t)` sets `currentTime` to `t` and drives every subscriber.
//   - `seek(t)` clamps to >= 0, updates `currentTime`, and notifies subscribers
//     (matching PracticeEngine.test.ts's clock, which fires on seek).
//   - `play` / `pause` are vi spies so tests can assert call wiring.
//
// It is intentionally NOT a `MasterClock` — consumers that take a `MasterClock`
// cast with `as unknown as MasterClock` (only `subscribe`/`currentTime`/`seek`
// /`play`/`pause` are exercised at that layer). See `MasterClock.test.ts`
// (Task A) for the real-arithmetic contract test.

import { vi } from 'vitest'

export interface FakeClock {
  /** Current playback time in seconds (driven by `emit`/`seek`). */
  readonly currentTime: number
  /** Set `currentTime` and notify all subscribers. */
  emit(t: number): void
  /** Clamp to >= 0, set `currentTime`, and notify all subscribers. */
  seek: ReturnType<typeof vi.fn>
  play: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  /** Register a listener; returns an unsubscribe fn. */
  subscribe(fn: (t: number) => void): () => void
}

export function fakeClock(): FakeClock {
  const listeners = new Set<(t: number) => void>()
  let t = 0
  const notify = (time: number) => {
    for (const fn of listeners) fn(time)
  }
  return {
    get currentTime() {
      return t
    },
    emit(newT: number) {
      t = newT
      notify(newT)
    },
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn((newT: number) => {
      t = Math.max(0, newT)
      notify(t)
    }),
    subscribe(fn: (t: number) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
