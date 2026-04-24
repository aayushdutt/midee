import { batch } from 'solid-js'
import { createStore, type SetStoreFunction } from 'solid-js/store'
import type { AppServices } from '../../../core/services'
import { makeQuestions, type Question } from './theory'

// Runtime state for the Intervals quiz. DOM-free so it can be reasoned about
// independently — the UI reads from `engine.state.*` (reactive in JSX) and
// writes only through intent methods here.
//
// Lifecycle:
//   `start()` generates the question plan, publishes question 0.
//   `playCurrent()` schedules the two interval notes via SynthEngine.
//   `answer(id)` checks against the current question, advances, and either
//     auto-plays the next or — on the last question — flips to 'done'.
//
// The engine does not drive the clock. Ear training is event-paced, not
// time-paced — the user decides when to hear a question again or answer.

export interface IntervalsEngineOptions {
  services: AppServices
  // Number of questions per session. Defaults match the hub UX brief.
  questionCount?: number
  // Which interval ids are in the pool for this run. Defaults to the
  // beginner four (M3 / P4 / P5 / octave) — the exercise caller can widen
  // this in the future without touching the engine.
  set?: readonly string[]
  // Seam for determinism in tests. Production code defaults to `Math.random`.
  rand?: () => number
  // Scheduler seam — injected in tests so the engine doesn't depend on a
  // real AudioContext.
  scheduleInterval?: (rootPitch: number, semitones: number) => void
}

export type IntervalsPhase = 'ready' | 'question' | 'feedback' | 'done'
export interface Feedback {
  correct: boolean
  // The user's pick (always set) and the right answer (always set) — the UI
  // reveals both after a miss and pulses the chosen button on a hit.
  picked: string
  answer: string
}

export interface IntervalsState {
  phase: IntervalsPhase
  index: number
  questions: readonly Question[]
  hits: number
  misses: number
  streak: number
  feedback: Feedback | null
}

export class IntervalsEngine {
  readonly state: IntervalsState
  private readonly write: SetStoreFunction<IntervalsState>

  private opts: {
    services: AppServices
    questionCount: number
    set: readonly string[]
    rand: () => number
    scheduleInterval?: (rootPitch: number, semitones: number) => void
  }
  // Guards against double-scoring when a user hammers two choice buttons
  // before the 'feedback' phase paints. Flipped on first answer, cleared on
  // next().
  private answered = false

  constructor(opts: IntervalsEngineOptions) {
    const [state, setState] = createStore<IntervalsState>({
      phase: 'ready',
      index: 0,
      questions: [],
      hits: 0,
      misses: 0,
      streak: 0,
      feedback: null,
    })
    this.state = state
    this.write = setState
    this.opts = {
      services: opts.services,
      questionCount: opts.questionCount ?? 10,
      set: opts.set ?? [],
      rand: opts.rand ?? Math.random,
      ...(opts.scheduleInterval ? { scheduleInterval: opts.scheduleInterval } : {}),
    }
  }

  start(): void {
    const questions = makeQuestions(this.opts.questionCount, this.opts.set, this.opts.rand)
    this.answered = false
    batch(() => {
      this.write({
        questions,
        index: 0,
        hits: 0,
        misses: 0,
        streak: 0,
        feedback: null,
        phase: questions.length === 0 ? 'done' : 'question',
      })
    })
  }

  // Stream the current question to the audio layer. Called by the UI on
  // mount and on "play again" — the engine itself never auto-replays.
  playCurrent(): void {
    const q = this.currentQuestion
    if (!q) return
    const schedule = this.opts.scheduleInterval ?? this.defaultSchedule
    schedule(q.rootPitch, q.semitones)
  }

  get currentQuestion(): Question | null {
    const q = this.state.questions[this.state.index]
    return q ?? null
  }

  answer(intervalId: string): Feedback | null {
    if (this.state.phase !== 'question' || this.answered) return null
    const q = this.currentQuestion
    if (!q) return null
    this.answered = true
    const correct = intervalId === q.intervalId
    const fb: Feedback = { correct, picked: intervalId, answer: q.intervalId }
    batch(() => {
      if (correct) {
        this.write({
          hits: this.state.hits + 1,
          streak: this.state.streak + 1,
          feedback: fb,
          phase: 'feedback',
        })
      } else {
        this.write({
          misses: this.state.misses + 1,
          streak: 0,
          feedback: fb,
          phase: 'feedback',
        })
      }
    })
    return fb
  }

  // Advance to the next question, or flip to 'done' after the last one.
  next(): void {
    if (this.state.phase !== 'feedback') return
    const nextIdx = this.state.index + 1
    this.answered = false
    if (nextIdx >= this.state.questions.length) {
      batch(() => {
        this.write({ feedback: null, phase: 'done' })
      })
      return
    }
    batch(() => {
      this.write({ feedback: null, index: nextIdx, phase: 'question' })
    })
  }

  get accuracy(): number {
    const total = this.state.hits + this.state.misses
    return total > 0 ? this.state.hits / total : 0
  }

  // Schedule two notes sequentially on the live synth: root at ctxNow, then
  // the upper pitch after the root has had time to sound. Using
  // `scheduleNoteOn` (not `liveNoteOn`) keeps the programmatic playback out
  // of the user-input paths — the keyboard UI doesn't highlight notes the
  // user didn't press, which is important for ear training.
  private defaultSchedule = (rootPitch: number, semitones: number): void => {
    const synth = this.opts.services.synth
    const ctxNow = synth.audioContextTime
    const NOTE = 0.72 // seconds each note sustains
    const GAP = 0.08 // gap between root release and upper attack
    const VEL = 0.85
    const topPitch = rootPitch + semitones
    synth.scheduleNoteOn(rootPitch, VEL, ctxNow + 0.02)
    synth.scheduleNoteOff(rootPitch, ctxNow + 0.02 + NOTE)
    synth.scheduleNoteOn(topPitch, VEL, ctxNow + 0.02 + NOTE + GAP)
    synth.scheduleNoteOff(topPitch, ctxNow + 0.02 + NOTE + GAP + NOTE)
  }
}
