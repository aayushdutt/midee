// Pure MIDI pitch → note-name table. Lives in its own module so test code
// (and any other tone-free consumer) can import it without dragging the Tone
// build, which won't resolve under vitest's node ESM loader.

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

const MIDI_NOTE_NAMES: readonly string[] = (() => {
  const out: string[] = new Array(128)
  for (let m = 0; m < 128; m++) {
    const octave = Math.floor(m / 12) - 1
    out[m] = `${NOTE_NAMES[m % 12]!}${octave}`
  }
  return out
})()

export function midiToNoteName(midi: number): string {
  return MIDI_NOTE_NAMES[midi]!
}
