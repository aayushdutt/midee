import { Show } from 'solid-js'
import { SHOW_FPS } from './env'
import { ModeSwitch } from './modes/ModeSwitch'
import { FpsOverlay } from './ui/FpsOverlay'

// Solid-owned root. Hosts <ModeSwitch/> (mode shells return null until
// T5–T8 fill them); <Portal/> + <Toast/> land with T17.
export function AppRoot() {
  return (
    <>
      <ModeSwitch />
      <Show when={SHOW_FPS}>
        <FpsOverlay />
      </Show>
    </>
  )
}
