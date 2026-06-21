// Minimal AudioContext stub for clock / synth / looper integration tests.
//
// MasterClock, SynthEngine, and LiveLooper all read time through Tone's
// `getContext().currentTime`. To test their scheduling deterministically you
// mock the `tone` module's `getContext` to return one of these stubs and drive
// `currentTime` by hand:
//
//   import { vi } from 'vitest'
//   import { fakeAudioContext } from '../test/fakeAudioContext'
//   const ctx = fakeAudioContext()
//   vi.mock('tone', () => ({ getContext: () => ctx }))
//   ...
//   ctx.currentTime = 1.5   // advance virtual audio time
//
// `currentTime` is a plain settable field (real AudioContext exposes it
// read-only, but tests need to drive it). `createGain`, `suspend`, `resume`,
// and `destination` are stubbed enough for nodes that touch the graph without
// producing audio. Extend per-test as new surface is needed — keep this lean.

import { vi } from 'vitest'

export interface FakeGainNode {
  gain: { value: number }
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

export interface FakeAudioContext {
  /** Virtual audio clock — settable so tests can advance time. */
  currentTime: number
  state: 'suspended' | 'running' | 'closed'
  destination: { maxChannelCount: number }
  createGain(): FakeGainNode
  suspend: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
}

export function fakeGainNode(): FakeGainNode {
  return {
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
}

export function fakeAudioContext(initialTime = 0): FakeAudioContext {
  return {
    currentTime: initialTime,
    state: 'running',
    destination: { maxChannelCount: 2 },
    createGain: () => fakeGainNode(),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
  }
}
