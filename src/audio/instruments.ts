// Factories only touch the current Tone context via `Tone.getDestination()`,
// so they work identically inside `Tone.Offline(...)` for export rendering.

import * as Tone from 'tone'

export type InstrumentId = 'piano' | 'rhodes' | 'pad' | 'pluck'

export interface InstrumentInfo {
  id: InstrumentId
  name: string       // display name
  sampled: boolean   // whether loading requires a network fetch
}

export const INSTRUMENTS: readonly InstrumentInfo[] = [
  { id: 'piano',  name: 'Piano',  sampled: true  },
  { id: 'rhodes', name: 'Rhodes', sampled: false },
  { id: 'pad',    name: 'Pad',    sampled: false },
  { id: 'pluck',  name: 'Pluck',  sampled: false },
]

export interface InstrumentRuntime {
  triggerAttack(note: string, time: number, velocity: number): void
  triggerRelease(note: string, time: number): void
  releaseAll(): void
  dispose(): void
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PianoModule = { Piano: any }
let pianoModule: PianoModule | null = null

async function getPianoModule(): Promise<PianoModule> {
  if (!pianoModule) {
    pianoModule = await import('@tonejs/piano') as unknown as PianoModule
  }
  return pianoModule
}

export async function createInstrument(id: InstrumentId): Promise<InstrumentRuntime> {
  switch (id) {
    case 'piano':  return await createPiano()
    case 'rhodes': return createRhodes()
    case 'pad':    return createPad()
    case 'pluck':  return createPluck()
  }
}

async function createPiano(): Promise<InstrumentRuntime> {
  try {
    const { Piano } = await getPianoModule()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst: any = new Piano({ velocities: 4 })
    inst.toDestination()
    await inst.load()
    return {
      triggerAttack: (note, time, velocity) => inst.keyDown({ note, velocity, time }),
      triggerRelease: (note, time) => inst.keyUp({ note, time }),
      releaseAll: () => inst.stopAll(),
      dispose: () => inst.dispose(),
    }
  } catch (err) {
    console.warn('Piano samples unavailable, falling back to PolySynth', err)
    return createTriangleFallback()
  }
}

function createTriangleFallback(): InstrumentRuntime {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.08, sustain: 0.55, release: 0.5 },
  }).toDestination()
  return wrapPolySynth(synth)
}

function createRhodes(): InstrumentRuntime {
  const synth = new Tone.PolySynth(Tone.FMSynth, {
    harmonicity: 3.2,
    modulationIndex: 6,
    oscillator: { type: 'sine' },
    envelope:   { attack: 0.002, decay: 0.9, sustain: 0.12, release: 1.0 },
    modulation: { type: 'sine' },
    modulationEnvelope: { attack: 0.004, decay: 0.6, sustain: 0.05, release: 0.4 },
  })
  const chorus = new Tone.Chorus(0.8, 2.5, 0.35).start()
  synth.chain(chorus, Tone.getDestination())
  return wrapPolySynth(synth)
}

function createPad(): InstrumentRuntime {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 24 },
    envelope:   { attack: 0.6, decay: 0.4, sustain: 0.8, release: 1.6 },
  })
  synth.volume.value = -10
  const filter = new Tone.Filter({ frequency: 1600, type: 'lowpass', rolloff: -12 })
  const reverb = new Tone.Reverb({ decay: 3.5, wet: 0.35 })
  synth.chain(filter, reverb, Tone.getDestination())
  return wrapPolySynth(synth)
}

function createPluck(): InstrumentRuntime {
  const synth = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'sawtooth' },
    envelope:   { attack: 0.002, decay: 0.18, sustain: 0, release: 0.9 },
  })
  synth.volume.value = -6
  const filter = new Tone.Filter({ frequency: 3800, type: 'highpass', rolloff: -12, Q: 0.5 })
  const lowpass = new Tone.Filter({ frequency: 6500, type: 'lowpass', rolloff: -24 })
  synth.chain(filter, lowpass, Tone.getDestination())
  return wrapPolySynth(synth)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapPolySynth(synth: any): InstrumentRuntime {
  return {
    triggerAttack: (note, time, velocity) => synth.triggerAttack(note, time, velocity),
    triggerRelease: (note, time) => synth.triggerRelease(note, time),
    releaseAll: () => synth.releaseAll(),
    dispose: () => synth.dispose(),
  }
}

// ── MIDI note-name table ────────────────────────────────────────────────

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
