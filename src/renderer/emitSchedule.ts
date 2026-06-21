// Pure per-frame particle-emission scheduler extracted from
// `PianoRollRenderer.renderFrame`. This is the *decision* layer: given the
// previous frame's active keys, the keys active *this* frame, the per-key
// next-emit schedule, and the current clock time, it decides which keys fire a
// note-on burst, which fire a sustained puff, and which schedule entries to
// reap — all without touching Pixi, geometry, or the ParticleSystem.
//
// Keys are the packed `trackIndex * 128 + pitch` integers the renderer uses in
// its hot path; this module never interprets them, it only diffs and reaps.
//
// Cadence (mirrors the constants the renderer applied inline):
//   - note-on (key not in `prev`)      → 'onset' burst, then schedule first
//                                          sustained puff at  t + initialDelay.
//   - held   (key in `prev`)           → if t >= scheduled time, 'sustain'
//                                          puff, then reschedule at t + interval.
//   - ended  (was scheduled, now gone) → reaped (schedule entry removed).

// Cadence for sustained emission. Must stay in sync with the renderer's
// SUSTAIN_INITIAL_DELAY_SEC / SUSTAIN_INTERVAL_SEC — passed in explicitly so
// this module owns no magic numbers and tests can pin exact timings.
export interface EmitCadence {
  /** Delay after a note-on before the first sustained puff. */
  initialDelaySec: number
  /** Interval between subsequent sustained puffs while held. */
  intervalSec: number
}

export type EmitKind = 'onset' | 'sustain'

export interface EmitEvent {
  /** Packed `trackIndex * 128 + pitch` key. */
  key: number
  kind: EmitKind
}

export interface EmitScheduleResult {
  /** Emissions to render this frame, in key-iteration order. */
  emits: EmitEvent[]
  /** Schedule entries removed because their note ended since last frame. */
  reaped: number[]
}

export interface ScheduleEmissionsArgs {
  /** Highlight-active keys from the previous frame (onset diff baseline). */
  prev: ReadonlySet<number>
  /**
   * Highlight-active keys this frame. Used both for the onset diff and to reap
   * schedule entries whose note ended — matching the renderer, a key that is
   * still highlight-active is NOT reaped even if it can't emit this frame.
   */
  curr: ReadonlySet<number>
  /**
   * Subset of `curr` permitted to emit particles this frame. When omitted,
   * every key in `curr` is emit-eligible. (The renderer narrows this to keys
   * where particles are enabled and the note isn't practice-gated.)
   */
  eligible?: ReadonlySet<number>
  /** Per-key next-emit time map; mutated in place. */
  schedule: Map<number, number>
  currentTime: number
  cadence: EmitCadence
}

/**
 * Decide this frame's particle emissions and update the next-emit schedule.
 *
 * `schedule` is mutated in place (set on onset / sustain, deleted on reap) so
 * the renderer can keep its long-lived pooled Map; the returned events/reaped
 * lists describe what changed for the caller to act on (draw bursts, etc.).
 *
 * Pure aside from the explicit `schedule` mutation — same inputs always yield
 * the same events and the same resulting `schedule`.
 */
export function scheduleEmissions(args: ScheduleEmissionsArgs): EmitScheduleResult {
  const { prev, curr, eligible, schedule, currentTime, cadence } = args
  const emits: EmitEvent[] = []

  const source = eligible ?? curr
  for (const key of source) {
    if (!prev.has(key)) {
      // Note-on: full initial burst + schedule the first sustained puff.
      emits.push({ key, kind: 'onset' })
      schedule.set(key, currentTime + cadence.initialDelaySec)
    } else {
      // Held note: release a small puff each tick the cadence is due.
      const nextAt = schedule.get(key)
      if (nextAt !== undefined && currentTime >= nextAt) {
        emits.push({ key, kind: 'sustain' })
        schedule.set(key, currentTime + cadence.intervalSec)
      }
    }
  }

  // Reap entries for notes that ended since the last frame. Reaping is keyed on
  // the full highlight set (`curr`), not the emit-eligible subset.
  const reaped: number[] = []
  for (const key of schedule.keys()) {
    if (!curr.has(key)) reaped.push(key)
  }
  for (const key of reaped) schedule.delete(key)

  return { emits, reaped }
}
