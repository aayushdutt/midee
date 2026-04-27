import { t } from '../i18n'

export function ModeError(props: { err: unknown; onRetry: () => void }) {
  const message = props.err instanceof Error ? props.err.message : String(props.err)
  return (
    <div class="mode-error">
      <div class="mode-error-inner">
        <div class="mode-error-title">{t('modeError.title')}</div>
        <div class="mode-error-message">{message}</div>
        <button class="mode-error-retry" type="button" onClick={() => props.onRetry()}>
          {t('modeError.retry')}
        </button>
      </div>
    </div>
  )
}
