import type { ExerciseResult } from './Result'
import { computeXp } from './scoring'

/** Common accuracy-to-result computation shared by play-along and similar
 *  exercises. Returns `null` when no attempts were made (avoids NaN scores). */
export function standardResult(params: {
  exerciseId: string
  hits: number
  misses: number
  difficultyWeight: number
  duration_s?: number
  weakSpots?: ExerciseResult['weakSpots']
  completed: boolean
}): ExerciseResult | null {
  const attempts = params.hits + params.misses
  if (attempts === 0) return null
  const accuracy = params.hits / attempts
  const duration = params.duration_s ?? 60
  return {
    exerciseId: params.exerciseId,
    duration_s: 0, // runner computes real duration from Session
    accuracy,
    xp: computeXp({ accuracy, duration_s: duration, difficultyWeight: params.difficultyWeight }),
    weakSpots: params.weakSpots ?? [],
    completed: params.completed,
  }
}
