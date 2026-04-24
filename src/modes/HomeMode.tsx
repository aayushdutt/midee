import { onMount } from 'solid-js'
import { t } from '../i18n'
import { useApp } from '../store/AppCtx'

// Landing surface — no loaded MIDI, no live session yet. Typing keyboard is
// kept live so the first key-press dissolves into live mode without an extra
// click (see App.handleLiveNoteOn for the `mode === 'home'` branch).
//
// Side effects run in onMount; by the time Solid mounts this component the
// store's mode is already 'home' (caller flipped it before the transition,
// or App.setMode('home') did). Calling `store.enterHome()` here is a no-op
// but keeps the shape resilient to callers that flipped `mode` without the
// other fields.
export function HomeMode() {
  const { services, trackPanel, dropzone, keyboardInput, resetInteractionState } = useApp()
  onMount(() => {
    resetInteractionState()
    services.store.enterHome()
    services.renderer.clearMidi()
    trackPanel.close()
    dropzone.show()
    keyboardInput.enable()
    document.title = t('doc.title.home')
  })
  return null
}
