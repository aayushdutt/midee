import { batch } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { MidiFile } from '../core/midi/types'

export type AppMode = 'home' | 'play' | 'live' | 'learn'
export type PlaybackStatus = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'exporting'

export interface AppStoreState {
  mode: AppMode
  status: PlaybackStatus
  loadedMidi: MidiFile | null
  currentTime: number
  duration: number
  volume: number
  speed: number
}

// The AppStore is the single source of truth for mode transitions, playback
// status, and the loaded MIDI. Consumers read `store.state.foo` (reactive
// inside a tracking scope, raw value outside) and write either through an
// intent method (multi-field, batched) or directly via `store.setState`.
export function createAppStore() {
  const [state, setState] = createStore<AppStoreState>({
    mode: 'home',
    status: 'idle',
    loadedMidi: null,
    currentTime: 0,
    duration: 0,
    volume: 0.8,
    speed: 1,
  })

  return {
    state,
    setState,
    // Multi-field transitions only — single-field writes go through setState.
    enterHome() {
      batch(() => {
        setState({
          mode: 'home',
          status: 'idle',
          loadedMidi: null,
          duration: 0,
          currentTime: 0,
        })
      })
    },
    beginPlayLoad() {
      batch(() => {
        setState({ mode: 'play', status: 'loading', currentTime: 0 })
      })
    },
    completePlayLoad(m: MidiFile) {
      batch(() => {
        setState({
          loadedMidi: m,
          duration: m.duration,
          currentTime: 0,
          mode: 'play',
          status: 'ready',
        })
      })
    },
    // Re-entry into Play mode without reloading MIDI — e.g. switching back
    // from Live or recovering from a failed load. Returns false when no MIDI
    // is loaded so the caller can fall back to the file picker.
    enterPlay(resetTime = true): boolean {
      if (state.loadedMidi === null) return false
      batch(() => {
        setState({
          mode: 'play',
          status: 'ready',
          duration: state.loadedMidi!.duration,
          ...(resetTime ? { currentTime: 0 } : {}),
        })
      })
      return true
    },
    enterLive(resetTime = true) {
      batch(() => {
        setState({
          mode: 'live',
          status: 'ready',
          ...(resetTime ? { currentTime: 0 } : {}),
        })
      })
    },
    get hasLoadedFile(): boolean {
      return state.loadedMidi !== null
    },
  }
}

export type AppStore = ReturnType<typeof createAppStore>
