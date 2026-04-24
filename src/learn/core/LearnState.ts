import { batch } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { MidiFile } from '../../core/midi/types'

// Learn mode's own transport + loaded-MIDI state. Kept isolated from
// `AppStore` so Learn never pollutes Play/Live and vice versa — a user can
// have a big piece loaded in Play, switch to Learn, load a short exercise
// MIDI, and return to Play without either mode's playhead or file being
// disturbed.
//
// The `mode` signal itself still lives on `AppStore` (it's the cross-cutting
// router). Everything else is mode-local.
//
// Status is a narrower enum than `AppStore.status` — Learn has no
// 'exporting' phase and no 'loading' mid-play (exercises own their own
// loading UX).

export type LearnStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused'

export interface LearnStateShape {
  loadedMidi: MidiFile | null
  currentTime: number
  duration: number
  status: LearnStatus
}

export function createLearnState() {
  const [state, setState] = createStore<LearnStateShape>({
    loadedMidi: null,
    currentTime: 0,
    duration: 0,
    status: 'idle',
  })
  return {
    state,
    setState,
    get hasLoadedMidi(): boolean {
      return state.loadedMidi !== null
    },
    beginLoad() {
      batch(() => {
        setState({ currentTime: 0, status: 'loading' })
      })
    },
    completeLoad(midi: MidiFile) {
      batch(() => {
        setState({
          loadedMidi: midi,
          duration: midi.duration,
          currentTime: 0,
          status: 'ready',
        })
      })
    },
    clearMidi() {
      batch(() => {
        setState({ loadedMidi: null, duration: 0, currentTime: 0, status: 'idle' })
      })
    },
  }
}

export type LearnState = ReturnType<typeof createLearnState>
