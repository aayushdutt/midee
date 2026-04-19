import { describe, expect, it } from 'vitest'
import { detectChord } from './ChordDetector'

// `detectChord` is a pure function: given a set of MIDI pitches, return a
// chord reading. These tests pin down the cases the live HUD actually
// surfaces — empty, monophonic, dyad, common triads, sevenths, inversions
// (slash chords), and unrecognised clusters. Failures here mean the chord
// chip will misread or stay blank where it shouldn't.

// MIDI cheat-sheet for the test cases below:
//   C4 = 60, D4 = 62, E4 = 64, F4 = 65, G4 = 67, A4 = 69, B4 = 71, C5 = 72
//   C#4 = 61, Eb4 = 63, F#4 = 66, G#4 = 68, Bb4 = 70

describe('detectChord', () => {
  it('returns the empty reading for no input', () => {
    const r = detectChord([])
    expect(r.name).toBeNull()
    expect(r.tonic).toBeNull()
    expect(r.quality).toBeNull()
    expect(r.pitchClasses).toEqual([])
  })

  it('a single note returns the pitch class as tonic, with no chord quality', () => {
    const r = detectChord([60]) // C4
    expect(r.tonic).toBe('C')
    // Quality is empty (no chord recognised from one note), not null —
    // the overlay treats falsy as "no suffix", not as missing data.
    expect(r.quality).toBeFalsy()
    expect(r.pitchClasses).toEqual(['C'])
  })

  it('detects a major triad in root position', () => {
    const r = detectChord([60, 64, 67]) // C E G
    // Tonal often returns "CM" for major; allow either common spelling.
    expect(r.tonic).toBe('C')
    expect(['M', 'maj', '']).toContain(r.quality ?? '')
    expect(r.pitchClasses).toEqual(['C', 'E', 'G'])
  })

  it('detects a minor triad in root position', () => {
    // A3, C4, E4 — A is the lowest pitch so root-position minor.
    const r = detectChord([57, 60, 64])
    expect(r.tonic).toBe('A')
    expect(r.quality).toBe('m')
  })

  it('detects a dominant seventh', () => {
    const r = detectChord([67, 71, 74, 77]) // G B D F → G7
    expect(r.tonic).toBe('G')
    expect(r.quality).toBe('7')
  })

  it('orders pitch classes with the lowest sounding note first', () => {
    // E G C (E in bass) — pitch class ordering is the contract that downstream
    // UI relies on for inversion display, regardless of how tonal labels the
    // chord itself (which can vary: C/E vs Em#5 are both defensible readings).
    const r = detectChord([64, 67, 72])
    expect(r.pitchClasses[0]).toBe('E')
    expect(r.name).not.toBeNull()
  })

  it('two-note inputs read as a power-chord-style dyad', () => {
    // C + G perfect fifth → C5
    const r = detectChord([60, 67])
    expect(r.tonic).toBe('C')
    // tonal usually labels this "5"; just confirm we produced *something*.
    expect(r.name).not.toBeNull()
  })

  it('returns pitch classes for unrecognised clusters even when no chord matches', () => {
    // Tone cluster — no recognised chord, but pitchClasses still useful for
    // the overlay's fallback display "F#·G·G#".
    const r = detectChord([66, 67, 68])
    expect(r.pitchClasses).toEqual(['F#', 'G', 'G#'])
  })

  it('dedupes octave-doubled pitches (same pitch class)', () => {
    // C3, C4, C5 — should collapse to a single "C" pitch class
    const r = detectChord([48, 60, 72])
    expect(r.pitchClasses).toEqual(['C'])
  })

  it('ignores non-finite inputs without throwing', () => {
    const r = detectChord([60, 64, 67, Number.NaN, Number.POSITIVE_INFINITY])
    expect(r.tonic).toBe('C')
  })
})
