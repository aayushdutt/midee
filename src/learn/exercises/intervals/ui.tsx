import { createEffect, For, onCleanup, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { icons } from '../../../ui/icons'
import type { IntervalsEngine } from './engine'
import { getInterval, getIntervalsByIds } from './theory'

// Card UI for the Intervals quiz. Single centered card — no piano roll behind
// it, no moveable panel. Ear training benefits from a focused, quiet surface
// so the user's attention stays on the sound. Reuses design tokens from the
// Learn hub (hero-card, pill buttons) so the visual language is consistent.

export interface IntervalsUiOptions {
  engine: IntervalsEngine
  answerSet: readonly string[]
  onCloseExercise: () => void
  // Fired whenever the user chooses. The controller uses this to flash the
  // shared overlay (celebrationSwell on hit, no-op on miss — the UI itself
  // renders the miss feedback inline).
  onAnswered?: (correct: boolean) => void
  // Fired once at the end so the LearnController can transition into the
  // session summary. The card itself stays mounted until `unmount()`.
  onFinished?: () => void
}

const PLAY_GLYPH =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><title>Play</title><path d="M7 5 L19 12 L7 19 Z"/></svg>'
const REPLAY_GLYPH =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><title>Replay</title><path d="M3 8a5 5 0 1 1 2 4"/><path d="M3 12v-4h4"/></svg>'
const NEXT_GLYPH =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><title>Next</title><path d="M5 3l5 5-5 5"/></svg>'

function IntervalsCard(props: IntervalsUiOptions) {
  const engine = props.engine
  const intervals = getIntervalsByIds(props.answerSet)
  const total = () => engine.state.questions.length
  const idx = () => engine.state.index
  const pct = () => (total() > 0 ? (idx() / total()) * 100 : 0)

  // Fire onFinished exactly once when the engine flips to 'done'.
  createEffect(() => {
    if (engine.state.phase === 'done') props.onFinished?.()
  })

  onMount(() => {
    // First question kicks off immediately — users expect audio on launch.
    // Slight delay so the overlay render + audio-context prime have a frame
    // to land before the first notes fire.
    const timer = window.setTimeout(() => engine.playCurrent(), 120)
    onCleanup(() => window.clearTimeout(timer))
  })

  function onPick(intervalId: string) {
    const fb = engine.answer(intervalId)
    if (fb) props.onAnswered?.(fb.correct)
  }

  function onNext() {
    engine.next()
    if (engine.state.phase === 'question') {
      window.setTimeout(() => engine.playCurrent(), 140)
    }
  }

  return (
    <div class="iv-card" data-phase={engine.state.phase}>
      <header class="iv-card__head">
        <div class="iv-card__crumb">
          <span class="iv-card__kicker">Ear training</span>
          <h2 class="iv-card__title">Intervals</h2>
        </div>
        <button
          class="iv-card__close"
          type="button"
          aria-label="Back to learn hub"
          data-tip="Back to hub (Esc)"
          onClick={() => props.onCloseExercise()}
          innerHTML={icons.close(14)}
        />
      </header>

      <div class="iv-card__progress">
        <div class="iv-card__progress-track">
          <div class="iv-card__progress-fill" style={{ '--pct': `${pct()}%` }} />
        </div>
        <div class="iv-card__progress-meta">
          <span>{total() > 0 ? `Question ${idx() + 1} of ${total()}` : 'Preparing…'}</span>
          <span class="iv-card__streak">
            {engine.state.streak >= 2 ? `🔥 ${engine.state.streak} in a row` : ''}
          </span>
        </div>
      </div>

      <div class="iv-card__body">
        <div class="iv-card__prompt">
          <span class="iv-card__prompt-label">Listen</span>
          <p class="iv-card__prompt-hint">
            Press play to hear two notes — pick the interval you just heard.
          </p>
        </div>
        <button
          class="iv-card__listen"
          type="button"
          aria-label="Play interval"
          data-tip="Play again (Space)"
          onClick={() => engine.playCurrent()}
        >
          <span class="iv-card__listen-glyph" aria-hidden="true" innerHTML={PLAY_GLYPH} />
          <span class="iv-card__listen-label">Play interval</span>
        </button>

        <fieldset class="iv-card__answers" aria-label="Choose an interval">
          <For each={intervals}>
            {(interval, i) => {
              const fb = () => engine.state.feedback
              return (
                <button
                  type="button"
                  class="iv-answer"
                  data-answer={interval.id}
                  data-tip={`${interval.full} · press ${i() + 1}`}
                  classList={{
                    'iv-answer--correct': fb() !== null && fb()!.answer === interval.id,
                    'iv-answer--wrong':
                      fb() !== null && !fb()!.correct && fb()!.picked === interval.id,
                  }}
                  onClick={() => onPick(interval.id)}
                >
                  <span class="iv-answer__short">{interval.short}</span>
                  <span class="iv-answer__full">{interval.full}</span>
                </button>
              )
            }}
          </For>
        </fieldset>

        <Show when={engine.state.feedback}>
          {(fb) => {
            const answerInterval = () => getInterval(fb().answer)
            const answerName = () => answerInterval()?.full ?? fb().answer
            const lastQuestion = () => engine.state.index === engine.state.questions.length - 1
            return (
              <div class="iv-card__feedback">
                <div class="iv-card__feedback-row">
                  <span
                    class="iv-card__feedback-badge"
                    classList={{
                      'iv-card__feedback-badge--ok': fb().correct,
                      'iv-card__feedback-badge--miss': !fb().correct,
                    }}
                  >
                    {fb().correct ? 'Correct' : 'Miss'}
                  </span>
                  <span class="iv-card__feedback-copy">
                    {fb().correct ? `${answerName()} — nice ear.` : `It was ${answerName()}.`}
                  </span>
                </div>
                <div class="iv-card__feedback-actions">
                  <button
                    class="iv-card__ghost"
                    type="button"
                    aria-label="Hear the interval again"
                    data-tip="Hear again"
                    onClick={() => engine.playCurrent()}
                  >
                    <span innerHTML={REPLAY_GLYPH} />
                    <span>Replay</span>
                  </button>
                  <button class="iv-card__next" type="button" onClick={() => onNext()}>
                    <span>{lastQuestion() ? 'Finish' : 'Next'}</span>
                    <span innerHTML={NEXT_GLYPH} />
                  </button>
                </div>
              </div>
            )
          }}
        </Show>
      </div>

      <footer class="iv-card__foot">
        <div class="iv-card__score">
          <span>{engine.state.hits}</span>
          <span class="iv-card__score-sep">/</span>
          <span>{engine.state.hits + engine.state.misses}</span>
        </div>
        <div class="iv-card__hint-row">
          <kbd>Space</kbd>
          <span>replay</span>
          <kbd>1-4</kbd>
          <span>pick answer</span>
        </div>
      </footer>
    </div>
  )
}

export class IntervalsUi {
  private dispose: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null

  constructor(private opts: IntervalsUiOptions) {}

  mount(host: HTMLElement): void {
    this.unmount()
    const wrapper = document.createElement('div')
    host.appendChild(wrapper)
    this.wrapper = wrapper
    this.dispose = render(() => <IntervalsCard {...this.opts} />, wrapper)
  }

  unmount(): void {
    this.dispose?.()
    this.dispose = null
    this.wrapper?.remove()
    this.wrapper = null
  }
}
