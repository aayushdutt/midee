import { batch } from 'solid-js'
import { createStore, type SetStoreFunction } from 'solid-js/store'
import type { BusNoteEvent } from '../../../core/input/InputBus'
import type { AppServices } from '../../../core/services'
import { watch } from '../../../store/watch'
import type { LearnState } from '../../core/LearnState'
import { type LoopRegion, makeRegionFromBars, ramp, wrapIfAtEnd } from '../../engines/LoopRegion'
import { PracticeEngine } from '../../engines/PracticeEngine'

// Runtime state for the Play-Along exercise. Composes wait-mode
// (PracticeEngine) with a loop-region + tempo-ramp layer on top. Kept
// separate from the UI so the state machine can be reasoned about (and
// tested) without touching DOM.
//
// Lifecycle: `attach(midi)` loads the piece, `setEnabled(true)` turns wait
// mode on, and the engine drives the clock from that point forward.
// `detach()` releases everything back to the host (App continues playback
// as-is when the exercise unmounts).

export type HandFilter = 'left' | 'right' | 'both'
export const DEFAULT_SPEED_PRESETS = [60, 80, 100] as const

export interface EngineOptions {
  services: AppServices
  // Learn's own transport state. The engine drives `status` here (not
  // `services.store.status`) so Play's transport isn't disturbed while an
  // exercise is running.
  learnState: LearnState
  // Called when the user completes a clean pass of the loop region. The
  // exercise passes this to the ramp controller and fires celebration UI.
  onCleanPass?: () => void
}

export interface PlayAlongState {
  loopRegion: LoopRegion | null
  speedPct: number
  hand: HandFilter
  tempoRampEnabled: boolean
  cleanPasses: number
  hits: number
  misses: number
  // `userWantsToPlay` is the source of truth for the play/pause icon — it
  // stays true across wait-mode pauses so the button doesn't flicker. The
  // lower-level `isPlaying` (clock actually advancing) is exposed in case a
  // future UI wants a finer-grained "waiting…" state.
  userWantsToPlay: boolean
  isPlaying: boolean
  currentTime: number
  duration: number
}

export class PlayAlongEngine {
  readonly practice: PracticeEngine
  readonly state: PlayAlongState
  readonly setState: SetStoreFunction<PlayAlongState>
  // Exposed so the HUD can subscribe to `services.clock` directly for its
  // 60 Hz imperative scrubber updates — avoids routing the tick through
  // a Solid store, which would re-fire every effect reading `currentTime`.
  readonly services: EngineOptions['services']

  private unsubs: Array<() => void> = []
  private active = false
  // Cached MIDI so `setHand` can re-run `applyHand` without reaching into
  // `PracticeEngine`'s internals. Cleared on `detach`.
  private currentMidi: import('../../../core/midi/types').MidiFile | null = null

  constructor(private opts: EngineOptions) {
    this.services = opts.services
    const [state, setState] = createStore<PlayAlongState>({
      loopRegion: null,
      speedPct: 100,
      hand: 'both',
      tempoRampEnabled: false,
      cleanPasses: 0,
      hits: 0,
      misses: 0,
      userWantsToPlay: false,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
    })
    this.state = state
    this.setState = setState

    this.practice = new PracticeEngine(opts.services.clock, {
      onWaitStart: () => {
        // Wait-mode is a transport-level pause: halt the clock AND flip
        // `learnState.status` so `LearnController`'s status listener
        // releases the synth. Without the status flip, the synth keeps
        // scheduling notes past a paused clock and drifts out of sync.
        this.opts.services.clock.pause()
        this.opts.learnState.setState('status', 'paused')
      },
      onWaitEnd: (resumeAt: number) => {
        // Always seek so internal state + scheduler align, but only resume
        // transport if the user actually wants playback.
        this.opts.services.clock.seek(resumeAt)
        if (this.state.userWantsToPlay) {
          this.opts.services.clock.play()
          this.opts.learnState.setState('status', 'playing')
        }
      },
    })
  }

  attach(midi: import('../../../core/midi/types').MidiFile | null): void {
    this.active = true
    this.currentMidi = midi
    const { services, learnState } = this.opts

    // Start from a known-still transport: pause clock + flip status so the
    // synth listener releases audio, then seek.
    services.clock.pause()
    learnState.setState('status', 'paused')

    // Seed from the clock — `learnState.currentTime` used to mirror this but
    // the 60 Hz mirror was pure overhead (nobody else reads it reactively).
    const seed = services.clock.currentTime
    const initial = midi && seed <= midi.duration ? seed : 0
    services.clock.seek(initial)

    // Now build practice steps + apply filters against the correct time.
    this.practice.loadMidi(midi)
    this.applyHand(midi)
    this.applySpeed()
    batch(() => {
      this.setState({ duration: midi?.duration ?? 0, currentTime: initial })
    })

    // Clock tick drives loop-wrap + currentTime mirror; status watch keeps
    // isPlaying in sync with Learn's transport.
    this.unsubs.push(
      services.clock.subscribe((t) => this.onTick(t)),
      watch(
        () => learnState.state.status,
        (s) => this.setState('isPlaying', s === 'playing'),
      ),
    )
  }

  detach(): void {
    this.active = false
    this.currentMidi = null
    this.setState('userWantsToPlay', false)
    for (const off of this.unsubs) off()
    this.unsubs = []
    this.opts.services.clock.pause()
    this.opts.learnState.setState('status', 'paused')
    this.practice.setEnabled(false)
    this.practice.dispose()
    this.opts.services.clock.speed = 1
    this.opts.services.synth.setSpeed(1)
  }

  // ── Transport controls exposed to the HUD ────────────────────────────

  play(): void {
    if (!this.active) return
    this.setState('userWantsToPlay', true)
    const { services, learnState } = this.opts
    this.practice.notifySeek(services.clock.currentTime)
    // Status BEFORE clock: clock.play()'s synchronous first tick may engage
    // wait-mode, which flips status back to paused. Set playing first so
    // synth.play is already in flight; SynthEngine's generation guard
    // aborts cleanly on the flip.
    learnState.setState('status', 'playing')
    services.clock.play()
  }

  pause(): void {
    this.setState('userWantsToPlay', false)
    this.opts.services.clock.pause()
    this.opts.learnState.setState('status', 'paused')
  }

  togglePlay(): void {
    if (this.state.userWantsToPlay) this.pause()
    else this.play()
  }

  seek(time: number): void {
    const clamped = Math.max(0, Math.min(this.state.duration || time, time))
    const wasPlaying = this.state.userWantsToPlay
    const { services, learnState } = this.opts
    services.clock.pause()
    learnState.setState('status', 'paused')
    services.clock.seek(clamped)
    services.synth.seek(clamped)
    learnState.setState('currentTime', clamped)
    this.practice.notifySeek(clamped)
    this.setState('currentTime', clamped)
    if (wasPlaying) {
      services.clock.play()
      learnState.setState('status', 'playing')
    }
  }

  onNoteOn(evt: BusNoteEvent): void {
    if (!this.active) return
    const result = this.practice.notePressed(evt.pitch)
    if (result === 'advanced') {
      this.setState('hits', this.state.hits + 1)
    } else if (result === 'rejected' && this.practice.isWaiting) {
      batch(() => {
        this.setState({
          misses: this.state.misses + 1,
          cleanPasses: 0,
        })
      })
    }
  }

  setWaitEnabled(enabled: boolean): void {
    this.practice.setEnabled(enabled)
  }

  setSpeedPreset(pct: number): void {
    this.setState('speedPct', pct)
    this.applySpeed()
  }

  setHand(filter: HandFilter): void {
    this.setState('hand', filter)
    this.applyHand(this.currentMidi)
  }

  setTempoRamp(enabled: boolean): void {
    this.setState('tempoRampEnabled', enabled)
    if (enabled) this.applyRampedSpeed()
  }

  setLoopFromBars(
    bars: number | null,
    playhead: number,
    pieceDuration: number,
    bpm: number,
  ): LoopRegion | null {
    const region = bars === null ? null : makeRegionFromBars(playhead, bars, bpm, pieceDuration)
    this.setState('loopRegion', region)
    return region
  }

  clearLoop(): void {
    this.setState('loopRegion', null)
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private applySpeed(): void {
    const base = this.state.speedPct / 100
    this.opts.services.clock.speed = base
    this.opts.services.synth.setSpeed(base)
  }

  private applyRampedSpeed(): void {
    const next = ramp(this.state.cleanPasses, [...DEFAULT_SPEED_PRESETS])
    if (next !== this.state.speedPct) {
      this.setState('speedPct', next)
      this.applySpeed()
    }
  }

  private applyHand(midi: import('../../../core/midi/types').MidiFile | null): void {
    if (!midi) return
    const filter = this.state.hand
    if (filter === 'both') {
      this.practice.setVisibleTracks(null)
      return
    }
    const visible = midi.tracks
      .filter((track) => {
        if (track.isDrum) return false
        const avg = averagePitch(track.notes)
        return filter === 'left' ? avg < 60 : avg >= 60
      })
      .map((t) => t.id)
    this.practice.setVisibleTracks(visible)
  }

  private onTick(time: number): void {
    // NOTE: we deliberately do NOT write `currentTime` into the store here.
    // Writing at 60 Hz would re-fire any `createEffect` reading it. The HUD
    // subscribes to `services.clock` directly for its imperative scrubber
    // update (§2 rule 4), so the store copy earned nothing and cost a
    // reactive re-run per frame. Seek() still writes once to reposition.
    const dur = this.state.duration
    if (dur > 0 && time >= dur && this.state.isPlaying) {
      this.pause()
      this.opts.services.clock.seek(dur)
      return
    }
    const region = this.state.loopRegion
    if (!region) return
    const wrapTo = wrapIfAtEnd(time, region)
    if (wrapTo !== null) {
      this.opts.services.clock.seek(wrapTo)
      this.opts.services.synth.seek(wrapTo)
      this.setState('cleanPasses', this.state.cleanPasses + 1)
      this.opts.onCleanPass?.()
      if (this.state.tempoRampEnabled) this.applyRampedSpeed()
    }
  }
}

function averagePitch(notes: { pitch: number }[]): number {
  if (notes.length === 0) return 60
  let sum = 0
  for (const n of notes) sum += n.pitch
  return sum / notes.length
}
