import { describe, expect, it } from 'vitest'
import {
  bassStaffStep,
  isAccidental,
  isWhiteKey,
  noteName,
  noteNameInKey,
  rangeForClef,
  staffForNote,
  staffStep,
} from './music'

describe('staffStep (treble clef)', () => {
  it('E4 = step 0 (bottom line)', () => {
    expect(staffStep(64)).toBe(0)
  })

  it('F4 = step 1 (first space)', () => {
    expect(staffStep(65)).toBe(1)
  })

  it('G4 = step 2 (second line)', () => {
    expect(staffStep(67)).toBe(2)
  })

  it('B4 = step 4 (third line)', () => {
    expect(staffStep(71)).toBe(4)
  })

  it('C5 = step 5 (first ledger line above)', () => {
    expect(staffStep(72)).toBe(5)
  })

  it('C4 = step -2 (one ledger line below treble staff)', () => {
    expect(staffStep(60)).toBe(-2)
  })

  it('F5 = step 8 (top line)', () => {
    expect(staffStep(77)).toBe(8)
  })

  it('sharp/flat variants share the same step as their natural', () => {
    expect(staffStep(61)).toBe(staffStep(60)) // C#4 vs C4
    expect(staffStep(66)).toBe(staffStep(65)) // F#4 vs F4
  })
})

describe('bassStaffStep', () => {
  it('G2 = step 0 (bottom line)', () => {
    expect(bassStaffStep(43)).toBe(0)
  })

  it('A2 = step 1 (first space)', () => {
    expect(bassStaffStep(45)).toBe(1)
  })

  it('B2 = step 2 (second line)', () => {
    expect(bassStaffStep(47)).toBe(2)
  })

  it('C3 = step 3 (first ledger line above bass staff)', () => {
    expect(bassStaffStep(48)).toBe(3)
  })

  it('C4 = step 10 (middle C, ledger above bass)', () => {
    expect(bassStaffStep(60)).toBe(10)
  })
})

describe('staffForNote', () => {
  it('MIDI 60 (C4) and above → treble', () => {
    expect(staffForNote(60)).toBe('treble')
    expect(staffForNote(72)).toBe('treble')
  })

  it('MIDI 59 (B3) and below → bass', () => {
    expect(staffForNote(59)).toBe('bass')
    expect(staffForNote(36)).toBe('bass')
  })
})

describe('noteName', () => {
  it('returns sharp-spelled names', () => {
    expect(noteName(60)).toBe('C')
    expect(noteName(61)).toBe('C♯')
    expect(noteName(66)).toBe('F♯')
    expect(noteName(70)).toBe('A♯')
  })
})

describe('rangeForClef', () => {
  it('treble → C4 to C6', () => {
    expect(rangeForClef('treble')).toEqual([60, 84])
  })

  it('bass → C2 to C4', () => {
    expect(rangeForClef('bass')).toEqual([36, 60])
  })

  it('both → C2 to C6', () => {
    expect(rangeForClef('both')).toEqual([36, 84])
  })
})

describe('noteNameInKey', () => {
  it('C major / unknown key: falls back to sharp spelling', () => {
    expect(noteNameInKey(66, 'C')).toBe('F♯')
    expect(noteNameInKey(70, 'Xmaj')).toBe('A♯')
  })

  it('G major (1 sharp): F# spelled as sharp', () => {
    expect(noteNameInKey(66, 'G')).toBe('F♯')
    expect(noteNameInKey(67, 'G')).toBe('G')
  })

  it('F major (1 flat): Bb spelled as flat', () => {
    expect(noteNameInKey(70, 'F')).toBe('B♭')
  })

  it('Bb major (2 flats): both Bb and Eb spelled as flats', () => {
    expect(noteNameInKey(70, 'Bb')).toBe('B♭')
    expect(noteNameInKey(63, 'Bb')).toBe('E♭')
  })

  it('D major (2 sharps): F# and C#', () => {
    expect(noteNameInKey(66, 'D')).toBe('F♯')
    expect(noteNameInKey(61, 'D')).toBe('C♯')
  })
})
