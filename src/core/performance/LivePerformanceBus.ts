import type { BusNoteEvent, InputSource } from '../input/InputBus'

/** A note event that has passed through the LivePerformanceBus — enriched with
 *  the merged pedal state so subscribers don't each re-derive it. */
export interface RoutedNoteEvent {
  pitch: number
  velocity: number
  clockTime: number
  source: InputSource
  /** True while any pedal source (MIDI or keyboard) is held. */
  pedalDown: boolean
}

export type NoteSink = (evt: RoutedNoteEvent) => void
export type PedalSink = (down: boolean) => void

/** Central fan-out hub for live performance note/pedal events. Owns:
 *  1. Pedal merge — keyboard OR MIDI pedal = global sustain.
 *  2. Sustained-pitches bookkeeping — repress-release logic.
 *  3. Subscriber fan-out — sinks receive normalised events.
 *
 *  The bus does NOT gate on app mode — callers (app.ts, modes) decide
 *  whether to route events through it. This keeps the bus pure while
 *  letting the orchestrator own policy. */
export interface LivePerformanceBus {
  readonly pedalDown: boolean
  /** Pitches currently held by the sustain pedal. Read-only. */
  readonly sustainedPitches: ReadonlySet<number>

  subscribeNotes(onNoteOn: NoteSink, onNoteOff: NoteSink): () => void
  subscribePedal(sink: PedalSink): () => void

  routeNoteOn(evt: BusNoteEvent): void
  routeNoteOff(evt: BusNoteEvent): void
  routePedalDown(source: InputSource): void
  routePedalUp(source: InputSource): void

  /** Emergency reset (blur / visibility hidden). Clears all pedal source
   *  flags, releases sustained pitches through note-off sinks (with real
   *  clockTime), and fires pedal subscribers (false). Leaves no stale
   *  state that could defer the next note-off. */
  forceReleaseAll(clockTime: number): void
}

export function createLivePerformanceBus(): LivePerformanceBus {
  const noteOnSinks = new Set<NoteSink>()
  const noteOffSinks = new Set<NoteSink>()
  const pedalSinks = new Set<PedalSink>()

  let _pedalDown = false
  const pedalSourceDown: Record<InputSource, boolean> = {
    midi: false,
    keyboard: false,
    touch: false,
  }
  const sustainedPitches = new Set<number>()

  function recomputePedal(): boolean {
    return pedalSourceDown.midi || pedalSourceDown.keyboard || pedalSourceDown.touch
  }

  return {
    get pedalDown(): boolean {
      return _pedalDown
    },

    get sustainedPitches(): ReadonlySet<number> {
      return sustainedPitches
    },

    subscribeNotes(onNoteOn: NoteSink, onNoteOff: NoteSink): () => void {
      noteOnSinks.add(onNoteOn)
      noteOffSinks.add(onNoteOff)
      return () => {
        noteOnSinks.delete(onNoteOn)
        noteOffSinks.delete(onNoteOff)
      }
    },

    subscribePedal(sink: PedalSink): () => void {
      pedalSinks.add(sink)
      return () => {
        pedalSinks.delete(sink)
      }
    },

    routeNoteOn(evt: BusNoteEvent): void {
      // Repress-release: if a pitch was pedal-sustained, emit note-off first
      // so subscribers don't see overlapping note-ons.
      if (sustainedPitches.has(evt.pitch)) {
        for (const fn of noteOffSinks) {
          fn({
            pitch: evt.pitch,
            velocity: 0,
            clockTime: evt.clockTime,
            source: evt.source,
            pedalDown: _pedalDown,
          })
        }
        sustainedPitches.delete(evt.pitch)
      }

      for (const fn of noteOnSinks) {
        fn({
          pitch: evt.pitch,
          velocity: evt.velocity,
          clockTime: evt.clockTime,
          source: evt.source,
          pedalDown: _pedalDown,
        })
      }
    },

    routeNoteOff(evt: BusNoteEvent): void {
      if (_pedalDown) {
        sustainedPitches.add(evt.pitch)
        return
      }

      for (const fn of noteOffSinks) {
        fn({
          pitch: evt.pitch,
          velocity: evt.velocity,
          clockTime: evt.clockTime,
          source: evt.source,
          pedalDown: _pedalDown,
        })
      }
    },

    routePedalDown(source: InputSource): void {
      pedalSourceDown[source] = true
      const was = _pedalDown
      _pedalDown = recomputePedal()
      if (!was && _pedalDown) {
        for (const fn of pedalSinks) fn(true)
      }
    },

    routePedalUp(source: InputSource): void {
      pedalSourceDown[source] = false
      const was = _pedalDown
      _pedalDown = recomputePedal()
      if (was && !_pedalDown) {
        // Use a sentinel clockTime of -1 — natural pedal-up has no single
        // event time. Subscribers that care about clockTime should use
        // their own clock.currentTime; this value is a clear signal that
        // the timestamp is synthetic.
        for (const pitch of sustainedPitches) {
          for (const fn of noteOffSinks) {
            fn({ pitch, velocity: 0, clockTime: -1, source: 'midi', pedalDown: false })
          }
        }
        sustainedPitches.clear()
        for (const fn of pedalSinks) fn(false)
      }
    },

    forceReleaseAll(clockTime: number): void {
      const wasDown = _pedalDown
      pedalSourceDown.midi = false
      pedalSourceDown.keyboard = false
      pedalSourceDown.touch = false
      _pedalDown = false

      if (wasDown) {
        for (const pitch of sustainedPitches) {
          for (const fn of noteOffSinks) {
            fn({ pitch, velocity: 0, clockTime, source: 'midi', pedalDown: false })
          }
        }
        for (const fn of pedalSinks) fn(false)
      }
      sustainedPitches.clear()
    },
  }
}
