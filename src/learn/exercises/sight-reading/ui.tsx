// SolidJS HUD for the sight-reading exercise.
// - SrControlBar: persistent glass bar above the keyboard, idles to 28% opacity
// - PauseOverlay: dim + resume prompt when paused
// - EndPanel: result card when phase is 'complete' or 'knockedOut'

import { createMemo, For, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { FloatingHud } from '../../../ui/FloatingHud'
import { icons } from '../../../ui/icons'
import { accuracy, computeXp } from '../../core/scoring'
import type { SightReadingEngine } from './engine'
import { gradeFromAccuracy, KNOCKOUT_THRESHOLD } from './engine'
import { noteName } from './music'
import type { TierConfig } from './types'

export interface SightReadHudOptions {
  engine: SightReadingEngine
  tier: TierConfig
  onPlayAgain: () => void
  onPracticeWeak: (pitches: number[]) => void
  onClose: () => void
}

// ── Grade colours ────────────────────────────────────────────────────────────

const GRADE_COLOR: Record<'S' | 'A' | 'B' | 'C' | 'D', string> = {
  S: '#f5c842',
  A: '#50c878',
  B: '#4a9eff',
  C: '#ff8c42',
  D: '#dc4646',
}

// ── Weak-note computation ────────────────────────────────────────────────────

interface WeakNote {
  midi: number
  name: string
  missRate: number
}

function computeWeakNotes(engine: SightReadingEngine): WeakNote[] {
  const results: WeakNote[] = []
  for (const [midi, { hits, misses }] of engine.noteStats) {
    const total = hits + misses
    if (total >= 5 && misses > 0) {
      results.push({ midi, name: noteName(midi), missRate: misses / total })
    }
  }
  return results.sort((a, b) => b.missRate - a.missRate).slice(0, 3)
}

// ── Control bar ──────────────────────────────────────────────────────────────
// Persistent bar above the keyboard wrapped in FloatingHud for consistent
// drag/pin/idle-fade behaviour across all HUDs.

function SrControlBar(props: SightReadHudOptions) {
  const { engine } = props

  const accuracyPct = createMemo(() => {
    const { perfect, good, missed } = engine.state
    const total = perfect + good + missed
    if (total < 5) return null
    return Math.round((100 * (perfect + good)) / total)
  })

  const streakClass = createMemo(() => {
    const s = engine.state.streak
    if (s >= 10) return 'sr-hud__streak sr-hud__streak--hot'
    if (s >= 5) return 'sr-hud__streak sr-hud__streak--warm'
    return 'sr-hud__streak'
  })

  const livesLeft = createMemo(() => KNOCKOUT_THRESHOLD - engine.state.consecutiveMisses)
  const lifeDots = createMemo(() =>
    Array.from({ length: KNOCKOUT_THRESHOLD }, (_, i) => i < livesLeft()),
  )

  return (
    <FloatingHud class="sr-hud" storageKey="midee.learn.sr" idleMs={2600}>
      {/* Streak — hidden at 0, like pa-hud */}
      <Show when={engine.state.streak > 0}>
        <span class={streakClass()}>
          <Show when={engine.state.streak >= 5}>
            <span aria-hidden="true">🔥</span>
          </Show>
          <span>{engine.state.streak}</span>
        </span>
        <div class="sr-hud__sep" />
      </Show>

      {/* Lives dots */}
      <div class="sr-hud__lives" role="status">
        <span class="sr-visually-hidden">{livesLeft()} lives remaining</span>
        <For each={lifeDots()}>
          {(alive) => (
            <span
              aria-hidden="true"
              class={alive ? 'sr-hud__dot' : 'sr-hud__dot sr-hud__dot--spent'}
            />
          )}
        </For>
      </div>

      <div class="sr-hud__sep" />

      {/* BPM control */}
      <div class="sr-hud__bpm">
        <button
          type="button"
          class="sr-hud__bpm-btn"
          aria-label="Decrease tempo"
          data-tip="Decrease tempo ([ while paused)"
          onClick={() => engine.setBpm(engine.bpm - 5)}
        >
          −
        </button>
        <span class="sr-hud__bpm-val">{Math.round(engine.state.bpm)}</span>
        <span class="sr-hud__bpm-label">BPM</span>
        <button
          type="button"
          class="sr-hud__bpm-btn"
          aria-label="Increase tempo"
          data-tip="Increase tempo (] while paused)"
          onClick={() => engine.setBpm(engine.bpm + 5)}
        >
          +
        </button>
      </div>

      <div class="sr-hud__sep" />

      {/* Accuracy */}
      <span class="sr-hud__acc" data-tip="Accuracy">
        {accuracyPct() !== null ? `${accuracyPct()}%` : '—'}
      </span>

      <div class="sr-hud__sep" />

      {/* Close */}
      <button
        type="button"
        class="sr-hud__close"
        aria-label="Back to hub"
        data-tip="Back to hub"
        onClick={props.onClose}
        innerHTML={icons.close(13)}
      />
    </FloatingHud>
  )
}

// ── Pause overlay ────────────────────────────────────────────────────────────

function PauseOverlay(props: { onResume: () => void }) {
  return (
    <div class="sr-pause">
      <div class="sr-pause__card">
        <span class="sr-pause__label">PAUSED</span>
        <button type="button" class="sr-pause__resume" onClick={props.onResume}>
          Resume
        </button>
        <span class="sr-pause__hint">
          or press <kbd class="sr-pause__kbd">Esc</kbd>
        </span>
      </div>
    </div>
  )
}

// ── End panel ────────────────────────────────────────────────────────────────

function EndPanel(props: SightReadHudOptions) {
  const { engine } = props
  const isKnockedOut = () => engine.state.phase === 'knockedOut'

  const acc = createMemo(() => {
    const { perfect, good, missed } = engine.state
    const total = perfect + good + missed
    if (total === 0) return null
    return accuracy(perfect + good, total)
  })

  const grade = createMemo(() => (acc() !== null ? gradeFromAccuracy(acc()!) : null))
  const gradeColor = createMemo(() => (grade() ? GRADE_COLOR[grade()!] : 'rgba(255,255,255,0.25)'))
  const xp = createMemo(() =>
    acc() !== null ? computeXp({ accuracy: acc()!, duration_s: 60, difficultyWeight: 1.0 }) : 0,
  )
  const weakNotes = createMemo(() => computeWeakNotes(engine))

  const subtitle = createMemo(() => {
    if (isKnockedOut()) return 'Knocked out'
    if (engine.state.totalPlayed < 3) return 'Not enough notes'
    return 'Session complete'
  })

  return (
    <div class="sr-end">
      <div class="sr-end__card">
        {/* Grade */}
        <div class="sr-end__grade-block">
          <div
            class="sr-end__grade"
            style={{ color: gradeColor(), 'text-shadow': `0 0 40px ${gradeColor()}55` }}
          >
            {grade() ?? '—'}
          </div>
          <div class="sr-end__subtitle">{subtitle()}</div>
        </div>

        {/* Stats row */}
        <div class="sr-end__stats">
          <div class="sr-end__stat sr-end__stat--perfect">
            <span class="sr-end__stat-glyph">✓</span>
            <span class="sr-end__stat-num">{engine.state.perfect}</span>
            <span class="sr-end__stat-label">Perfect</span>
          </div>
          <div class="sr-end__stat sr-end__stat--good">
            <span class="sr-end__stat-glyph">◌</span>
            <span class="sr-end__stat-num">{engine.state.good}</span>
            <span class="sr-end__stat-label">Good</span>
          </div>
          <div class="sr-end__stat sr-end__stat--miss">
            <span class="sr-end__stat-glyph">✗</span>
            <span class="sr-end__stat-num">{engine.state.missed}</span>
            <span class="sr-end__stat-label">Missed</span>
          </div>
          <div class="sr-end__stat">
            <span class="sr-end__stat-glyph">↑</span>
            <span class="sr-end__stat-num">{engine.state.bestStreak}</span>
            <span class="sr-end__stat-label">Best streak</span>
          </div>
        </div>

        {/* XP badge */}
        <Show when={xp() > 0}>
          <div class="sr-end__xp">+{xp()} XP</div>
        </Show>

        {/* Weak notes */}
        <Show when={weakNotes().length > 0}>
          <div class="sr-end__weak">
            Trouble with:{' '}
            <span class="sr-end__weak-notes">
              {weakNotes()
                .map((w) => w.name)
                .join(', ')}
            </span>
          </div>
        </Show>

        {/* CTAs */}
        <div class="sr-end__actions">
          <button
            type="button"
            class="sr-end__btn sr-end__btn--primary"
            onClick={props.onPlayAgain}
          >
            Play Again
          </button>
          <Show when={weakNotes().length > 0}>
            <button
              type="button"
              class="sr-end__btn sr-end__btn--secondary"
              onClick={() => props.onPracticeWeak(weakNotes().map((w) => w.midi))}
            >
              Practice Weak Notes
            </button>
          </Show>
          <button type="button" class="sr-end__btn sr-end__btn--ghost" onClick={props.onClose}>
            Back to hub
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Root component ───────────────────────────────────────────────────────────

function SightReadHudRoot(props: SightReadHudOptions) {
  const phase = () => props.engine.state.phase
  const isPaused = () => props.engine.state.paused
  const isActive = () => phase() === 'playing'
  const isDone = () => phase() === 'knockedOut' || phase() === 'complete'

  return (
    <>
      <Show when={isActive()}>
        <SrControlBar {...props} />
      </Show>
      <Show when={isActive() && isPaused()}>
        <PauseOverlay onResume={() => props.engine.resume()} />
      </Show>
      <Show when={isDone()}>
        <EndPanel {...props} />
      </Show>
    </>
  )
}

// ── Public class ─────────────────────────────────────────────────────────────

export class SightReadHud {
  private dispose: (() => void) | null = null
  private container: HTMLDivElement | null = null

  mount(host: HTMLElement, opts: SightReadHudOptions): void {
    const div = document.createElement('div')
    div.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10'
    host.appendChild(div)
    this.container = div
    this.dispose = render(() => <SightReadHudRoot {...opts} />, div)
  }

  unmount(): void {
    this.dispose?.()
    this.container?.remove()
    this.dispose = null
    this.container = null
  }
}
