import { createSignal } from 'solid-js'
import { watch } from './watch'

// Tiny event-bus primitive used by imperative subsystems (InputBus, MIDI
// devices, Metronome, SessionRecorder, …). Mirrors the old `Signal<T>` class
// API — `.value` getter, `.set(v)`, `.subscribe(fn)` — but is implemented on
// top of Solid's `createSignal` + `watch` so the whole app runs on one
// reactive runtime. The factory form is deliberate: these signals sit on
// long-lived class instances, so no reactive owner is implied by construction.
//
// `subscribe(fn)` matches the pre-port semantics: no initial fire, fn gets the
// new value on every `set()`. Returns an unsubscribe closure.
export interface EventSignal<T> {
  readonly value: T
  set(v: T): void
  subscribe(fn: (v: T) => void): () => void
}

export function createEventSignal<T>(initial: T): EventSignal<T> {
  const [read, write] = createSignal<T>(initial, { equals: false })
  return {
    get value() {
      return read()
    },
    set(v: T) {
      write(() => v)
    },
    subscribe(fn: (v: T) => void): () => void {
      return watch(read, fn)
    },
  }
}
