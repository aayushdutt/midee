import type { MidiFile } from '../core/midi/types'
import type { AppMode, AppStore } from '../store/state'
import { watch } from '../store/watch'
import type { KeyLights } from './KeyLights'

// Own Play's light source once, including mode exits and export. Learn owns
// its source while an exercise is attached. Read the untouched source identity
// to distinguish a transpose/export restore from a newly loaded song.
export function bindPlayKeyLights(
  lights: KeyLights,
  store: AppStore,
  disabledTracks: () => ReadonlySet<string>,
): () => void {
  let previousMode: AppMode | null = null
  let previousFile: MidiFile | null = null
  let previousSource: MidiFile | null = null
  const read = () =>
    [
      store.state.mode,
      store.state.loadedMidi,
      store.state.sourceMidi,
      store.state.status === 'exporting',
    ] as const
  const sync = ([mode, midi, source, exporting]: ReturnType<typeof read>) => {
    const file = mode === 'play' && !exporting ? midi : null
    if (mode === previousMode && file === previousFile && source === previousSource) return
    const preserveMutes = source === previousSource
    previousMode = mode
    previousFile = file
    previousSource = source
    // Audio resets mutes after completePlayLoad; at this point its mute IDs
    // still belong to the old song. Restore them only for the same source.
    lights.load(file, file && preserveMutes ? disabledTracks() : [])
  }
  sync(read())
  return watch(read, sync)
}
