import { createContext, useContext } from 'solid-js'
import type { AppServices } from '../core/services'
import type { ComputerKeyboardInput } from '../midi/ComputerKeyboardInput'
import type { MidiInputManager } from '../midi/MidiInputManager'
import type { LearnController } from '../modes/LearnController'
import type { DropZone } from '../ui/DropZone'
import type { TrackPanel } from '../ui/TrackPanel'
import type { AppStore } from './state'

// Context value threaded via `<AppCtx.Provider value={ctx}>`. `services` and
// `store` are the long-term surface; the rest are transitional handles that
// Solid mode components need while legacy UI classes (owned by App) still
// live outside the Solid tree. They dissolve in T2b (App class deletion)
// alongside T12 (LearnHub port), T15 (TrackPanel/DropZone port), and T17
// (Toast).
export interface AppCtxValue {
  services: AppServices
  store: AppStore
  // Transitional handles (removed progressively as each module ports):
  trackPanel: TrackPanel
  dropzone: DropZone
  keyboardInput: ComputerKeyboardInput
  midiInput: MidiInputManager
  learnController: LearnController
  resetInteractionState: () => void
  openFilePicker: () => void
  primeInteractiveAudio: () => void
}

export const AppCtx = createContext<AppCtxValue>()

export function useApp(): AppCtxValue {
  const v = useContext(AppCtx)
  if (!v) throw new Error('useApp() called outside <AppCtx.Provider>')
  return v
}
