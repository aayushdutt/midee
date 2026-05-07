import { describe, expect, it } from 'vitest'
import { standardResult } from './resultHelpers'

describe('standardResult', () => {
  it('returns null when no attempts were made', () => {
    const r = standardResult({
      exerciseId: 'test',
      hits: 0,
      misses: 0,
      difficultyWeight: 1,
      completed: false,
    })
    expect(r).toBeNull()
  })

  it('computes accuracy from hits / (hits + misses)', () => {
    const r = standardResult({
      exerciseId: 'test',
      hits: 8,
      misses: 2,
      difficultyWeight: 1,
      completed: true,
    })
    expect(r).not.toBeNull()
    expect(r!.accuracy).toBeCloseTo(0.8)
    expect(r!.exerciseId).toBe('test')
    expect(r!.completed).toBe(true)
  })

  it('returns empty weakSpots by default', () => {
    const r = standardResult({
      exerciseId: 'test',
      hits: 1,
      misses: 0,
      difficultyWeight: 1,
      completed: true,
    })
    expect(r!.weakSpots).toEqual([])
  })

  it('returns provided weakSpots', () => {
    const spots = [{ pitch: 60, expected: 60, count: 3 }]
    const r = standardResult({
      exerciseId: 'test',
      hits: 5,
      misses: 1,
      difficultyWeight: 1,
      weakSpots: spots,
      completed: true,
    })
    expect(r!.weakSpots).toBe(spots)
  })

  it('includes an xp value', () => {
    const r = standardResult({
      exerciseId: 'test',
      hits: 10,
      misses: 0,
      difficultyWeight: 1,
      completed: true,
    })
    expect(r!.xp).toBeGreaterThan(0)
  })

  it('duration_s is always 0 (runner stamps real duration)', () => {
    const r = standardResult({
      exerciseId: 'test',
      hits: 1,
      misses: 0,
      difficultyWeight: 1,
      completed: true,
    })
    expect(r!.duration_s).toBe(0)
  })
})
