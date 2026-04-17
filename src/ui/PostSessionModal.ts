// Shown when live-mode session recording ends. Offers three clear next
// steps so users aren't forced into an immediate download — they can
// visualize the take, save it as MIDI, or discard it.

export type SessionAction = 'open-in-file' | 'download' | 'discard'

export class PostSessionModal {
  private el: HTMLElement
  private statsEl!: HTMLElement
  private phase: 'open' | 'closed' = 'closed'

  onAction?: (action: SessionAction) => void

  constructor(container: HTMLElement) {
    this.el = document.createElement('div')
    this.el.id = 'post-session-modal'
    this.el.innerHTML = `
      <div class="post-session-card">
        <header class="export-header">
          <div class="export-card-icon">${ICON_WAVEFORM}</div>
          <div class="export-header-text">
            <h2 class="export-card-title">Session recorded</h2>
            <p class="export-card-sub" id="ps-stats">—</p>
          </div>
        </header>

        <div class="post-session-actions">
          <button class="post-session-option post-session-option--primary"
                  data-action="open-in-file" type="button">
            <span class="post-session-option-icon">${ICON_TIMELINE}</span>
            <span class="post-session-option-body">
              <span class="post-session-option-title">Open in file mode</span>
              <span class="post-session-option-sub">Visualize it as a rolling piano roll — ready to export as MP4.</span>
            </span>
          </button>

          <button class="post-session-option" data-action="download" type="button">
            <span class="post-session-option-icon">${ICON_DOWNLOAD}</span>
            <span class="post-session-option-body">
              <span class="post-session-option-title">Download MIDI</span>
              <span class="post-session-option-sub">Send <code>.mid</code> straight to your DAW.</span>
            </span>
          </button>

          <button class="post-session-option post-session-option--muted"
                  data-action="discard" type="button">
            <span class="post-session-option-icon">${ICON_TRASH}</span>
            <span class="post-session-option-body">
              <span class="post-session-option-title">Discard</span>
              <span class="post-session-option-sub">Throw it away and keep jamming.</span>
            </span>
          </button>
        </div>
      </div>
    `
    container.appendChild(this.el)
    this.bindEvents()
  }

  open(durationSec: number, noteCount: number): void {
    this.statsEl.textContent = `${formatMMSS(durationSec)} · ${noteCount} note${noteCount === 1 ? '' : 's'}`
    this.phase = 'open'
    this.el.classList.add('open')
  }

  close(): void {
    this.phase = 'closed'
    this.el.classList.remove('open')
  }

  private bindEvents(): void {
    this.statsEl = this.el.querySelector<HTMLElement>('#ps-stats')!
    this.el.querySelectorAll<HTMLButtonElement>('.post-session-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset['action'] as SessionAction
        this.onAction?.(action)
      })
    })
    // Click the backdrop to discard. Matches the export modal's dismiss gesture.
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el && this.phase === 'open') this.onAction?.('discard')
    })
  }
}

function formatMMSS(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m.toString().padStart(1, '0')}:${sec.toString().padStart(2, '0')}`
}

const ICON_WAVEFORM = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
  <line x1="3" y1="12" x2="3" y2="12"/>
  <line x1="7" y1="8" x2="7" y2="16"/>
  <line x1="11" y1="4" x2="11" y2="20"/>
  <line x1="15" y1="9" x2="15" y2="15"/>
  <line x1="19" y1="6" x2="19" y2="18"/>
</svg>`

const ICON_TIMELINE = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="4" width="18" height="16" rx="2"/>
  <line x1="3" y1="10" x2="21" y2="10"/>
  <line x1="8" y1="10" x2="8" y2="20"/>
  <line x1="14" y1="10" x2="14" y2="20"/>
</svg>`

const ICON_DOWNLOAD = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" y1="15" x2="12" y2="3"/>
</svg>`

const ICON_TRASH = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="3 6 5 6 21 6"/>
  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
  <path d="M10 11v6M14 11v6"/>
  <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
</svg>`
