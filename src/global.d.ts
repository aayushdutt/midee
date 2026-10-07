import type { BenchResult } from './bench/runner'

declare global {
  interface MIDIOutput {
    /** Cancel MIDI messages queued with future timestamps (Web MIDI API). */
    clear(): void
  }

  // Bench-only fields. The runner module + these props are gated behind
  // `import.meta.env.VITE_ENABLE_BENCH` in main.tsx, so they're absent from
  // public prod builds.
  interface Window {
    /** Set by the bench runner when `?bench=<suite>` is present (see `scripts/bench.mjs`). */
    __BENCH_RESULT?: BenchResult
    __BENCH_ERROR?: string
    /** Set by `?bench=list` — fixture ids, discovered by the driver. */
    __BENCH_FIXTURES?: string[]
    /** Set by `?bench=list` — synthetic audio fixture ids for the audio suites. */
    __BENCH_AUDIO_FIXTURES?: string[]
    /** Live phase marker — read by the driver to diagnose timeouts. */
    __BENCH_PROGRESS?: string
    /** Set by `?bench=glowshots` — PNG data URLs keyed `<theme>-<moment>-<mode>`. */
    __GLOW_SHOTS?: Record<string, string>
    /** Set by `?bench=glowshots` — the fixture times each moment was rendered at. */
    __GLOW_SHOT_TIMES?: Record<string, number>
  }
}
