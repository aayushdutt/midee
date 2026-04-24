import { ModeSwitch } from './modes/ModeSwitch'

// Solid-owned root. Hosts <ModeSwitch/> (mode shells return null until
// T5–T8 fill them); <Portal/> + <Toast/> land with T17.
export function AppRoot() {
  return <ModeSwitch />
}
