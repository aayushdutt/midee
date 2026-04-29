import { onCleanup, Show } from 'solid-js'
import { t } from '../../i18n'
import type { ExerciseResult } from '../core/Result'
import { createMountHandle } from './mountComponent'

export interface SessionSummaryOptions {
  onAgain: () => void
  onNext: () => void
  // Auto-fade delay in ms. 0 disables auto-fade (user has to click). Default
  // 4000 matches the v2 plan.
  autoFadeMs?: number
}

interface ViewProps extends SessionSummaryOptions {
  result: ExerciseResult
  streakExtended: boolean
  xpGained: number
  onDismiss: () => void
}

function SessionSummaryView(props: ViewProps) {
  const accuracyPct = Math.round(props.result.accuracy * 100)
  const fade = props.autoFadeMs ?? 4000
  if (fade > 0) {
    // onCleanup fires when the caller disposes the Solid root (via dismiss()).
    // That covers both the auto-fade and user-triggered paths cleanly.
    const timer = setTimeout(() => props.onDismiss(), fade)
    onCleanup(() => clearTimeout(timer))
  }
  return (
    <div class="session-summary" role="status">
      <div class="session-summary__row">
        <div class="session-summary__metric">
          <span class="session-summary__value">{accuracyPct}%</span>
          <span class="session-summary__label">{t('learn.summary.accuracy')}</span>
        </div>
        <div class="session-summary__metric">
          <span class="session-summary__value">+{props.xpGained}</span>
          <span class="session-summary__label">{t('learn.summary.xp')}</span>
        </div>
        <Show when={props.streakExtended}>
          <div class="session-summary__metric session-summary__metric--streak">
            <span class="session-summary__value">{t('learn.summary.streakBump')}</span>
          </div>
        </Show>
        <div class="session-summary__actions">
          <button
            class="session-summary__btn"
            type="button"
            onClick={() => {
              props.onDismiss()
              props.onAgain()
            }}
          >
            {t('learn.summary.again')}
          </button>
          <button
            class="session-summary__btn session-summary__btn--primary"
            type="button"
            onClick={() => {
              props.onDismiss()
              props.onNext()
            }}
          >
            {t('learn.summary.next')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function createSessionSummary(opts: SessionSummaryOptions) {
  const handle = createMountHandle(SessionSummaryView)
  const autoFadeMs = opts.autoFadeMs

  return {
    show(
      host: HTMLElement,
      result: ExerciseResult,
      extras: { streakExtended: boolean; xpGained: number },
    ): void {
      handle.mount(host, {
        onAgain: opts.onAgain,
        onNext: opts.onNext,
        ...(autoFadeMs !== undefined ? { autoFadeMs } : {}),
        result,
        streakExtended: extras.streakExtended,
        xpGained: extras.xpGained,
        onDismiss: () => handle.unmount(),
      })
    },
    dismiss(): void {
      handle.unmount()
    },
  }
}
