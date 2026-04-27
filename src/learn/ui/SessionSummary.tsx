import { onCleanup, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { t } from '../../i18n'
import type { ExerciseResult } from '../core/Result'

// Quiet end-of-session surface. Slides up from the bottom, displays accuracy
// + XP + streak-extended hint (if applicable), gives Again / Next buttons,
// then fades itself after a timeout. Deliberately not a modal — it doesn't
// block interaction and doesn't steal focus.
//
// The public surface stays imperative (`new SessionSummary(...); show(...)`)
// because LearnController mounts it from its own class body. T12/T8b wrap-up
// will replace this with a Solid signal inside <LearnMode/>.
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

export class SessionSummary {
  private dispose: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null

  constructor(private opts: SessionSummaryOptions) {}

  show(
    host: HTMLElement,
    result: ExerciseResult,
    extras: { streakExtended: boolean; xpGained: number },
  ): void {
    this.dismiss()
    // Solid's render() replaces contents of its mount node — give it a
    // dedicated wrapper so we don't clobber the hub or exercise DOM that
    // already lives in `host`.
    const wrapper = document.createElement('div')
    host.appendChild(wrapper)
    this.wrapper = wrapper
    const autoFadeMs = this.opts.autoFadeMs
    this.dispose = render(
      () => (
        <SessionSummaryView
          onAgain={this.opts.onAgain}
          onNext={this.opts.onNext}
          {...(autoFadeMs !== undefined ? { autoFadeMs } : {})}
          result={result}
          streakExtended={extras.streakExtended}
          xpGained={extras.xpGained}
          onDismiss={() => this.dismiss()}
        />
      ),
      wrapper,
    )
  }

  dismiss(): void {
    this.dispose?.()
    this.dispose = null
    this.wrapper?.remove()
    this.wrapper = null
  }
}
