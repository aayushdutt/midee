import { describe, expect, it } from 'vitest'
import type { MidiNote } from '../core/midi/types'
import { visibleNoteRange } from './viewport'

const note = (time: number, duration: number): MidiNote => ({
  pitch: 60,
  time,
  duration,
  velocity: 0.8,
})

describe('visibleNoteRange', () => {
  it('returns [0,0] for an empty array', () => {
    expect(visibleNoteRange([], 0, 10)).toEqual([0, 0])
  })

  it('returns the full array when all notes are in range', () => {
    const notes = [note(1, 0.5), note(2, 0.5), note(3, 0.5)]
    expect(visibleNoteRange(notes, 0, 10)).toEqual([0, 3])
  })

  it('excludes notes entirely before visStart', () => {
    // note ends at 1.0, visStart is 2.0 — should be excluded
    const notes = [note(0, 1), note(3, 0.5), note(5, 0.5)]
    const [lo, hi] = visibleNoteRange(notes, 2, 8)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([3, 5])
  })

  it('excludes notes starting after visEnd', () => {
    // note starts at 10.0, visEnd is 5.0 — should be excluded
    const notes = [note(1, 0.5), note(3, 0.5), note(10, 0.5)]
    const [lo, hi] = visibleNoteRange(notes, 0, 5)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([1, 3])
  })

  it('includes a note that started before visStart but extends into view (scan-back)', () => {
    // Long sustained note: starts at 0, lasts 10s. visStart=5, visEnd=8.
    const notes = [note(0, 10), note(6, 0.5)]
    const [lo, hi] = visibleNoteRange(notes, 5, 8)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([0, 6])
  })

  it('handles visStart === visEnd (active-note point query)', () => {
    // Only the note containing t=5 should be returned.
    const notes = [note(0, 3), note(3, 3), note(7, 2)]
    // note at t=3, dur=3 covers [3,6] — contains t=5
    const [lo, hi] = visibleNoteRange(notes, 5, 5)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([3])
  })

  it('includes a note starting exactly at visEnd', () => {
    const notes = [note(5, 1)]
    const [lo, hi] = visibleNoteRange(notes, 0, 5)
    expect(hi - lo).toBe(1)
  })

  it('excludes a note ending exactly at visStart (strict)', () => {
    // note ends at exactly visStart — not strictly inside the window
    const notes = [note(0, 2), note(3, 1)]
    // visStart=2: note(0,2) ends at 2.0, not > 2.0 → excluded
    const [lo, hi] = visibleNoteRange(notes, 2, 5)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([3])
  })

  it('handles a single note in range', () => {
    const notes = [note(4, 1)]
    expect(visibleNoteRange(notes, 3, 6)).toEqual([0, 1])
  })

  it('handles a single note out of range', () => {
    const notes = [note(10, 1)]
    expect(visibleNoteRange(notes, 0, 5)).toEqual([0, 0])
  })

  it('handles many notes with only the middle slice visible', () => {
    const notes = Array.from({ length: 100 }, (_, i) => note(i, 0.5))
    const [lo, hi] = visibleNoteRange(notes, 40, 60)
    // notes 40–60 start in [40, 60]; note 39 ends at 39.5 < 40, excluded
    expect(notes[lo]!.time).toBe(40)
    expect(notes[hi - 1]!.time).toBe(60)
  })

  it('multiple long notes all overlapping visStart are all included via scan-back', () => {
    // Three notes start before visStart=10 but extend past it; note at t=20 is after visEnd=15
    const notes = [note(0, 15), note(5, 12), note(8, 5), note(20, 1)]
    const [lo, hi] = visibleNoteRange(notes, 10, 15)
    expect(notes.slice(lo, hi).map((n) => n.time)).toEqual([0, 5, 8])
  })
})
