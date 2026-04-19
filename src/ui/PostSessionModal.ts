// Shown when live-mode session recording ends. Offers three clear next
// steps so users aren't forced into an immediate download — they can
// visualize the take, save it as MIDI, or discard it.

import { t, tn } from '../i18n'
import { icons } from './icons'
import { Modal } from './primitives/Modal'

export type SessionAction = 'open-in-file' | 'download' | 'discard'

export class PostSessionModal {
  private modal: Modal
  private statsEl!: HTMLElement

  onAction?: (action: SessionAction) => void

  constructor(container: HTMLElement) {
    const innerHTML = `
      <div class="post-session-card">
        <header class="export-header">
          <div class="export-card-icon">${icons.waveform()}</div>
          <div class="export-header-text">
            <h2 class="export-card-title">${t('postSession.title')}</h2>
            <p class="export-card-sub" id="ps-stats">—</p>
          </div>
        </header>

        <div class="post-session-actions">
          <button class="post-session-option post-session-option--primary"
                  data-action="open-in-file" type="button">
            <span class="post-session-option-icon">${icons.timeline()}</span>
            <span class="post-session-option-body">
              <span class="post-session-option-title">${t('postSession.openInFile.title')}</span>
              <span class="post-session-option-sub">${t('postSession.openInFile.sub')}</span>
            </span>
          </button>

          <button class="post-session-option" data-action="download" type="button">
            <span class="post-session-option-icon">${icons.download(18)}</span>
            <span class="post-session-option-body">
              <span class="post-session-option-title">${t('postSession.download.title')}</span>
              <span class="post-session-option-sub">${t('postSession.download.sub.html')}</span>
            </span>
          </button>

          <button class="post-session-option post-session-option--muted"
                  data-action="discard" type="button">
            <span class="post-session-option-icon">${icons.trash()}</span>
            <span class="post-session-option-body">
              <span class="post-session-option-title">${t('postSession.discard.title')}</span>
              <span class="post-session-option-sub">${t('postSession.discard.sub')}</span>
            </span>
          </button>
        </div>
      </div>
    `
    // Escape + backdrop map to 'discard' — matches the muted-option semantics.
    this.modal = new Modal(container, 'post-session-modal', innerHTML, {
      onDismiss: () => this.onAction?.('discard'),
    })
    this.statsEl = this.modal.el.querySelector<HTMLElement>('#ps-stats')!
    this.modal.el.querySelectorAll<HTMLButtonElement>('.post-session-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset['action'] as SessionAction
        this.onAction?.(action)
      })
    })
  }

  open(durationSec: number, noteCount: number): void {
    // Plural via tn() — handles English one/other and any locale's CLDR
    // categories (Polish few/many, Arabic six forms, etc.) automatically.
    this.statsEl.textContent = tn('postSession.stats', noteCount, { duration: formatMMSS(durationSec) })
    this.modal.open()
  }

  close(): void {
    this.modal.close()
  }

  dispose(): void {
    this.modal.dispose()
  }
}

function formatMMSS(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m.toString().padStart(1, '0')}:${sec.toString().padStart(2, '0')}`
}
