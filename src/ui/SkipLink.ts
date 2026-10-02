import { t } from '../i18n'
import type { AppMode } from '../store/state'

// Focus real controls rather than the canvas: users can continue with Tab or
// activate the current mode's primary action immediately. Hidden/collapsed
// controls refuse focus in the browser, so try the remaining candidates.
const CONTENT_TARGETS: Record<AppMode, string[]> = {
  home: ['#home-open'],
  play: ['#hud-play', '#hud button'],
  live: ['#hud-metro', '#hud button'],
  learn: ['.learn-host--exercise button', '.learn-host--hub button'],
}

export function installSkipLink(getMode: () => AppMode): void {
  const link = document.querySelector<HTMLAnchorElement>('.skip-link')
  if (!link) return
  link.textContent = t('a11y.skipToMain')
  // Navigation here must not also trigger the app's global musical shortcuts.
  link.addEventListener('keydown', (event) => event.stopPropagation())
  link.addEventListener('click', (event) => {
    event.preventDefault()
    for (const selector of CONTENT_TARGETS[getMode()]) {
      for (const target of document.querySelectorAll<HTMLElement>(selector)) {
        target.focus({ preventScroll: true })
        if (document.activeElement === target) return
      }
    }
    document.querySelector<HTMLElement>('#app')?.focus({ preventScroll: true })
  })
}
