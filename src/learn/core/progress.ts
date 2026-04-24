import { createStore, reconcile } from 'solid-js/store'
import { jsonPersisted } from '../../core/persistence'
import { applyStreak, type CommitOutcome, commitResult, isoDay } from './progress-actions'
import {
  emptyProgress,
  type LearnProgressV1,
  type LearnSettings,
  migrateProgress,
} from './progress-schema'
import type { ExerciseResult } from './Result'

const STORAGE_KEY = 'midee.learn.v1'

// Stateful façade over the progress schema + pure action helpers. The
// underlying state is a `createStore` so consumers get fine-grained tracking:
// a component that reads `progress.state.streak.days` only re-runs when that
// field changes, not when XP or settings flip.
//
// `reconcile` on writes diffs the new snapshot against the live proxy and
// only signals the fields that actually changed — cheaper than a blanket
// re-publish.
export function createLearnProgressStore(today: () => string = () => isoDay(new Date())) {
  const persisted = jsonPersisted<LearnProgressV1>(STORAGE_KEY, emptyProgress(), migrateProgress)
  const [state, setState] = createStore<LearnProgressV1>(persisted.load())

  function writeAndPublish(next: LearnProgressV1): void {
    persisted.save(next)
    setState(reconcile(next))
  }

  return {
    state,
    // Touches the streak for the current day without committing anything else.
    // Useful when the hub surfaces a "today's practice" indicator — opening
    // the app and playing for a bit already counts, even before an exercise
    // ends.
    touchStreak(): { extended: boolean } {
      const prev = state
      const { next, extended } = applyStreak(prev.streak, today())
      if (!extended) return { extended: false }
      writeAndPublish({ ...prev, streak: next })
      return { extended: true }
    },
    // Folds an exercise result into the store. Returns the commit outcome so
    // the caller can fire analytics (learn_streak_extended, xp_gained, etc.)
    // on the same tick that the UI updates.
    commit(result: ExerciseResult): CommitOutcome {
      const outcome = commitResult(state, result, today())
      writeAndPublish(outcome.next)
      return outcome
    },
    updateSettings(partial: Partial<LearnSettings>): void {
      writeAndPublish({
        ...state,
        settings: { ...state.settings, ...partial },
      })
    },
    // Replace state entirely. Used by tests and any future "reset all
    // progress" affordance. No partial — callers supply the whole shape.
    overwrite(next: LearnProgressV1): void {
      writeAndPublish(next)
    },
    // Convenience read helpers. UI reads `progress.state.*` directly and
    // derives what it needs; these are for callsites that want a one-shot
    // non-reactive read without `.state.streak.days` boilerplate.
    get streakDays(): number {
      return state.streak.days
    },
    get xp(): number {
      return state.xp.total
    },
    get settings(): LearnSettings {
      return state.settings
    },
  }
}

export type LearnProgressStore = ReturnType<typeof createLearnProgressStore>
