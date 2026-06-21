import { describe, expect, it } from 'vitest'
import type { CapturedEvent } from './MidiEncoding'
import { sessionToMidiFile } from './SessionToMidi'

// `sessionToMidiFile` returns the internal `MidiFile` shape directly, so unlike
// `MidiEncoding.test.ts` (which round-trips through @tonejs/midi) we can assert
// on the produced note model in place. The pairing/orphan/floor logic mirrors
// `encodeCapturedEvents`, but with a 0.05s duration floor (vs 0.01s there).

const notesOf = (events: CapturedEvent[], duration = 10, bpm = 120) =>
  sessionToMidiFile(events, duration, bpm).tracks[0]!.notes

describe('sessionToMidiFile', () => {
  it('pairs a single on/off into one note with the right duration and velocity', () => {
    const notes = notesOf([
      { type: 'on', pitch: 60, velocity: 0.8, time: 1 },
      { type: 'off', pitch: 60, velocity: 0, time: 3 },
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ pitch: 60, time: 1, duration: 2, velocity: 0.8 })
  })

  it('closes a dangling note-on at the session duration', () => {
    const notes = notesOf([{ type: 'on', pitch: 64, velocity: 1, time: 2 }], /* duration */ 7)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ pitch: 64, time: 2, duration: 5 })
  })

  it('applies the 0.05s minimum duration floor to a zero-length note', () => {
    const notes = notesOf([
      { type: 'on', pitch: 60, velocity: 1, time: 1 },
      { type: 'off', pitch: 60, velocity: 0, time: 1 },
    ])
    expect(notes[0]!.duration).toBe(0.05)
  })

  it('floors an orphan note whose on-time is at/after the session duration', () => {
    // Dangling on at the very end → duration - time = 0, clamped to 0.05.
    const notes = notesOf([{ type: 'on', pitch: 72, velocity: 1, time: 5 }], /* duration */ 5)
    expect(notes[0]!.duration).toBe(0.05)
  })

  it('pairs repeated on/off on the same pitch FIFO', () => {
    const notes = notesOf([
      { type: 'on', pitch: 60, velocity: 1, time: 0 },
      { type: 'on', pitch: 60, velocity: 1, time: 0.5 },
      { type: 'off', pitch: 60, velocity: 0, time: 1 },
      { type: 'off', pitch: 60, velocity: 0, time: 1.5 },
    ])
    expect(notes).toHaveLength(2)
    // Output is sorted by time; FIFO pairs first-on→first-off.
    expect(notes[0]).toMatchObject({ time: 0, duration: 1 })
    expect(notes[1]).toMatchObject({ time: 0.5, duration: 1 })
  })

  it('ignores off events with no matching on', () => {
    const notes = notesOf([
      { type: 'off', pitch: 60, velocity: 0, time: 0.5 },
      { type: 'on', pitch: 62, velocity: 1, time: 1 },
      { type: 'off', pitch: 62, velocity: 0, time: 2 },
    ])
    expect(notes).toHaveLength(1)
    expect(notes[0]!.pitch).toBe(62)
  })

  it('sorts the resulting notes by start time', () => {
    // Emit later note first; output must be time-ordered.
    const notes = notesOf([
      { type: 'on', pitch: 67, velocity: 1, time: 4 },
      { type: 'off', pitch: 67, velocity: 0, time: 5 },
      { type: 'on', pitch: 60, velocity: 1, time: 1 },
      { type: 'off', pitch: 60, velocity: 0, time: 2 },
    ])
    expect(notes.map((n) => n.time)).toEqual([1, 4])
  })

  it('produces an empty track for no events', () => {
    const file = sessionToMidiFile([], 10, 120)
    expect(file.tracks).toHaveLength(1)
    expect(file.tracks[0]!.notes).toHaveLength(0)
  })

  it('carries through name, bpm, duration and a non-drum track', () => {
    const file = sessionToMidiFile([], 12, 90, 'Take 1')
    expect(file).toMatchObject({ name: 'Take 1', bpm: 90, duration: 12, timeSignature: [4, 4] })
    expect(file.tracks[0]).toMatchObject({ channel: 0, isDrum: false })
  })
})
