import { createEffect, createRoot, on } from 'solid-js'

// Permanent bridge from the reactive scope to imperative subsystems (synth,
// metronome, input managers, anything instantiated outside a Solid component).
// `read` runs as a tracked effect; `cb` fires on every change. Returns a
// dispose fn that tears the effect down — callers keep it on their lifecycle
// list and invoke on destroy.
//
// `defer: true` mirrors the legacy `Signal<T>.subscribe` semantics: the
// callback fires on *changes*, never on the initial read. Call sites that
// want an initial fire do it explicitly before subscribing. Without defer we
// silently double-execute every setup-time effect at boot.
export function watch<T>(read: () => T, cb: (v: T) => void): () => void {
  return createRoot((dispose) => {
    createEffect(on(read, (v) => cb(v), { defer: true }))
    return dispose
  })
}
