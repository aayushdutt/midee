// Pure music-theory helpers for sight-reading rendering and note naming.
// Ported from the POC at midi-learning/src/lib/music.ts; extended with
// noteNameInKey() for key-signature-aware spelling.

const SEMI_TO_DIATONIC = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]
const ACCIDENTAL = [false, true, false, true, false, false, true, false, true, false, true, false]
const WHITE_KEYS = new Set([0, 2, 4, 5, 7, 9, 11])
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']

// E4 (MIDI 64) sits on the bottom line of the treble clef — staff step 0.
const E4_DIATONIC = 4 * 7 + 2 // 30

// G2 (MIDI 43) sits on the bottom line of the bass clef — bass step 0.
const G2_DIATONIC = 2 * 7 + 4 // 18

export type ClefMode = 'treble' | 'bass' | 'both'

/** Diatonic staff steps above the bottom treble-clef line (E4). */
export function staffStep(midi: number): number {
  const semitone = midi % 12
  const octave = Math.floor(midi / 12) - 1
  return octave * 7 + SEMI_TO_DIATONIC[semitone]! - E4_DIATONIC
}

/** Diatonic staff steps above the bottom bass-clef line (G2). */
export function bassStaffStep(midi: number): number {
  const semitone = midi % 12
  const octave = Math.floor(midi / 12) - 1
  return octave * 7 + SEMI_TO_DIATONIC[semitone]! - G2_DIATONIC
}

/** Which staff a note belongs to in "both" mode. */
export function staffForNote(midi: number): 'treble' | 'bass' {
  return midi >= 60 ? 'treble' : 'bass'
}

/** Y-coordinate for a given staff step. */
export function yFromStep(step: number, staffTop: number, lineSpacing: number): number {
  return staffTop + 4 * lineSpacing - step * (lineSpacing / 2)
}

export function isAccidental(midi: number): boolean {
  return ACCIDENTAL[midi % 12]!
}

export function isWhiteKey(midi: number): boolean {
  return WHITE_KEYS.has(midi % 12)
}

export function noteName(midi: number): string {
  return NOTE_NAMES[midi % 12]!
}

/** Note range defaults for each clef. */
export function rangeForClef(clef: ClefMode): [number, number] {
  if (clef === 'bass') return [36, 60] // C2–C4
  if (clef === 'treble') return [60, 84] // C4–C6
  return [36, 84] // C2–C6
}

// Key signature data: pitch classes (0–11) that are sharped or flatted.
// Matches KEY_SIGNATURES in the POC's key-signatures.ts.
interface KeySigData {
  sharps: number[]
  flats: number[]
}

const KEY_SIG_DATA: Record<string, KeySigData> = {
  C: { sharps: [], flats: [] },
  G: { sharps: [6], flats: [] },
  D: { sharps: [6, 1], flats: [] },
  A: { sharps: [6, 1, 8], flats: [] },
  E: { sharps: [6, 1, 8, 3], flats: [] },
  F: { sharps: [], flats: [10] },
  Bb: { sharps: [], flats: [10, 3] },
  Eb: { sharps: [], flats: [10, 3, 8] },
  Ab: { sharps: [], flats: [10, 3, 8, 1] },
}

/**
 * Returns the note name correctly spelled for a key signature.
 * Flat keys spell accidentals as flats; sharp keys spell them as sharps.
 * Falls back to noteName() for unknown key strings.
 */
export function noteNameInKey(midi: number, keySignature: string): string {
  const ks = KEY_SIG_DATA[keySignature]
  if (!ks) return noteName(midi)
  if (ks.flats.length > 0) return FLAT_NAMES[midi % 12]!
  return NOTE_NAMES[midi % 12]!
}
