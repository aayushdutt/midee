export function ModeError(props: { err: unknown; onRetry: () => void }) {
  const message = props.err instanceof Error ? props.err.message : String(props.err)
  return (
    <div class="mode-error">
      <div class="mode-error-inner">
        <div class="mode-error-title">Something went wrong</div>
        <div class="mode-error-message">{message}</div>
        <button class="mode-error-retry" type="button" onClick={() => props.onRetry()}>
          Try again
        </button>
      </div>
    </div>
  )
}
