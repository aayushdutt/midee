import { createSignal, onMount } from 'solid-js'
import { t } from '../i18n'
import { useApp } from '../store/AppCtx'
import { trackEvent } from '../telemetry'
import type { EnterOptions } from './ModeController'

// Transient options for the next Live-mode entry. Populated by the caller
// (App.enterLiveMode) immediately before flipping `mode` to 'live', read by
// LiveMode's onMount, then reset. Stays a module-scope signal so a ported
// caller (T18 TopStrip) can set it without any DI plumbing.
const [pendingOpts, setPendingOpts] = createSignal<EnterOptions>({ primeAudio: true })
export function setNextLiveOpts(opts: EnterOptions): void {
  setPendingOpts(opts)
}

// Real-time performance surface. No MIDI file loaded; the piano roll is
// driven by the live note store and the loop station.
export function LiveMode() {
  const {
    services,
    trackPanel,
    dropzone,
    keyboardInput,
    midiInput,
    resetInteractionState,
    primeInteractiveAudio,
  } = useApp()

  onMount(() => {
    const { primeAudio = true } = pendingOpts()
    setPendingOpts({ primeAudio: true })
    resetInteractionState()
    services.store.enterLive()
    services.renderer.clearMidi()
    trackPanel.close()
    dropzone.hide()
    keyboardInput.enable()
    document.title = t('doc.title.live')
    if (primeAudio) primeInteractiveAudio()
    // LiveMode only mounts on transition into live, so every mount is a
    // real entry — fire analytics unconditionally.
    trackEvent('live_mode_entered', {
      midi_connected: midiInput.status.value === 'connected',
    })
  })
  return null
}
