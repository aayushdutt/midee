import { createEffect, For, on, onCleanup, onMount, Show } from 'solid-js'
import { type MessageKey, t } from '../../../i18n'
import { icons } from '../../../ui/icons'
import { createMountHandle } from '../../ui/mountComponent'
import type { IntervalsEngine } from './engine'
import { getInterval, getIntervalsByIds } from './theory'

const PLAY_GLYPH = icons.play(20)
const REPLAY_GLYPH = icons.replay(12)
const NEXT_GLYPH = icons.next(12)

function intervalFullName(id: string): string {
  return t(`learn.interval.${id}` as MessageKey)
}

export interface IntervalsUiOptions {
  engine: IntervalsEngine
  answerSet: readonly string[]
  onCloseExercise: () => void
  onAnswered?: (correct: boolean) => void
  onFinished?: () => void
}

function IntervalsCard(props: IntervalsUiOptions) {
  const engine = props.engine
  const intervals = getIntervalsByIds(props.answerSet)
  const total = () => engine.state.questions.length
  const idx = () => engine.state.index
  const pct = () => (total() > 0 ? (idx() / total()) * 100 : 0)

  // Fire onFinished when `phase` transitions to `done` only (not on unrelated
  // store fields — `on` tracks a single accessor).
  createEffect(
    on(
      () => engine.state.phase,
      (phase) => {
        if (phase === 'done') props.onFinished?.()
      },
      { defer: true },
    ),
  )

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
          <span class="iv-card__kicker">{t('learn.intervals.kicker')}</span>
          <h2 class="iv-card__title">{t('learn.intervals.title')}</h2>
        </div>
        <button
          class="iv-card__close"
          type="button"
          aria-label={t('learn.intervals.backAria')}
          data-tip={t('learn.intervals.backTip')}
          onClick={() => props.onCloseExercise()}
          innerHTML={icons.close(14)}
        />
      </header>

      <div class="iv-card__progress">
        <div class="iv-card__progress-track">
          <div class="iv-card__progress-fill" style={{ '--pct': `${pct()}%` }} />
        </div>
        <div class="iv-card__progress-meta">
          <span>
            {total() > 0
              ? t('learn.intervals.questionOf', { n: idx() + 1, total: total() })
              : t('learn.intervals.preparing')}
          </span>
          <span class="iv-card__streak">
            {engine.state.streak >= 2
              ? t('learn.intervals.streakInRow', { n: engine.state.streak })
              : ''}
          </span>
        </div>
      </div>

      <div class="iv-card__body">
        <div class="iv-card__prompt">
          <span class="iv-card__prompt-label">{t('learn.intervals.listen')}</span>
          <p class="iv-card__prompt-hint">{t('learn.intervals.listenHint')}</p>
        </div>
        <button
          class="iv-card__listen"
          type="button"
          aria-label={t('learn.intervals.playAria')}
          data-tip={t('learn.intervals.playTip')}
          onClick={() => engine.playCurrent()}
        >
          <span class="iv-card__listen-glyph" aria-hidden="true" innerHTML={PLAY_GLYPH} />
          <span class="iv-card__listen-label">{t('learn.intervals.playLabel')}</span>
        </button>

        <fieldset class="iv-card__answers" aria-label={t('learn.intervals.choose')}>
          <For each={intervals}>
            {(interval, i) => {
              const fb = () => engine.state.feedback
              return (
                <button
                  type="button"
                  class="iv-answer"
                  data-answer={interval.id}
                  data-tip={t('learn.intervals.answerTip', {
                    full: intervalFullName(interval.id),
                    n: i() + 1,
                  })}
                  classList={{
                    'iv-answer--correct': fb() !== null && fb()!.answer === interval.id,
                    'iv-answer--wrong':
                      fb() !== null && !fb()!.correct && fb()!.picked === interval.id,
                  }}
                  onClick={() => onPick(interval.id)}
                >
                  <span class="iv-answer__short">{interval.short}</span>
                  <span class="iv-answer__full">{intervalFullName(interval.id)}</span>
                </button>
              )
            }}
          </For>
        </fieldset>

        <Show when={engine.state.feedback}>
          {(fb) => {
            const answerInterval = () => getInterval(fb().answer)
            const answerName = () =>
              answerInterval() ? intervalFullName(answerInterval()!.id) : fb().answer
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
                    {fb().correct ? t('learn.intervals.correct') : t('learn.intervals.miss')}
                  </span>
                  <span class="iv-card__feedback-copy">
                    {fb().correct
                      ? t('learn.intervals.correctMsg', { name: answerName() })
                      : t('learn.intervals.missMsg', { name: answerName() })}
                  </span>
                </div>
                <div class="iv-card__feedback-actions">
                  <button
                    class="iv-card__ghost"
                    type="button"
                    aria-label={t('learn.intervals.replayAria')}
                    data-tip={t('learn.intervals.replayTip')}
                    onClick={() => engine.playCurrent()}
                  >
                    <span innerHTML={REPLAY_GLYPH} />
                    <span>{t('learn.intervals.replayLabel')}</span>
                  </button>
                  <button class="iv-card__next" type="button" onClick={() => onNext()}>
                    <span>
                      {lastQuestion() ? t('learn.intervals.finish') : t('learn.intervals.next')}
                    </span>
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
          <span>{t('learn.intervals.shortcutReplay')}</span>
          <kbd>1-4</kbd>
          <span>{t('learn.intervals.shortcutPick')}</span>
        </div>
      </footer>
    </div>
  )
}

export function createIntervalsUi() {
  return createMountHandle(IntervalsCard)
}
