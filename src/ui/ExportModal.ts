import type { ExportStage } from '../export/VideoExporter'

// Supported export resolution presets. `match` keeps the current canvas size
// (whatever the user's window is) — useful for already-well-sized displays or
// for users who've tuned the window to look exactly how they want. `vertical`
// (1080×1920) and `square` (1080×1080) target TikTok/Reels/Shorts and
// Instagram feed respectively.
export type ExportResolution = 'match' | '720p' | '1080p' | 'vertical' | 'square'
export type ExportOutput = 'av' | 'video-only' | 'audio-only'

export interface ExportSettings {
  fps: number
  resolution: ExportResolution
  output: ExportOutput
}

interface PresetCard {
  id: ExportResolution
  label: string
  dim: string
  aspect: 'landscape' | 'vertical' | 'square' | 'match'
  hint?: string
}

// Ordered so the default (1080p) is first and the social formats cluster
// together — matches how users scan the card grid.
const PRESETS: readonly PresetCard[] = [
  { id: '1080p',    label: '1080p',    dim: '1920 × 1080', aspect: 'landscape' },
  { id: '720p',     label: '720p',     dim: '1280 × 720',  aspect: 'landscape' },
  { id: 'vertical', label: 'Vertical', dim: '1080 × 1920', aspect: 'vertical', hint: 'TikTok / Reels / Shorts' },
  { id: 'square',   label: 'Square',   dim: '1080 × 1080', aspect: 'square',   hint: 'Instagram feed' },
  { id: 'match',    label: 'Match',    dim: 'Current size', aspect: 'match' },
]

export class ExportModal {
  private el: HTMLElement
  private settingsPhase!: HTMLElement
  private progressPhase!: HTMLElement
  private progressBar!: HTMLElement
  private stageEl!: HTMLElement
  private pctEl!: HTMLElement
  private phase: 'settings' | 'progress' = 'settings'
  private selectedFps = 30
  private selectedResolution: ExportResolution = '1080p'
  private selectedOutput: ExportOutput = 'av'

  onStart?: (settings: ExportSettings) => void
  onCancel?: () => void

  constructor(container: HTMLElement) {
    this.el = document.createElement('div')
    this.el.id = 'export-modal'
    this.el.innerHTML = `
      <div class="export-card">

        <div class="export-phase" id="ep-settings">
          <header class="export-header">
            <div class="export-card-icon">${ICON_FILM}</div>
            <div class="export-header-text">
              <h2 class="export-card-title">Export MP4</h2>
              <p class="export-card-sub">Frame-accurate · audio baked in · fully offline</p>
            </div>
          </header>

          <section class="export-section">
            <span class="export-section-label">Output</span>
            <div class="fps-group out-group" id="out-group">
              <button class="fps-btn fps-btn--on" data-out="av">Video + audio</button>
              <button class="fps-btn" data-out="video-only">Video only</button>
              <button class="fps-btn" data-out="audio-only">Audio only</button>
            </div>
          </section>

          <section class="export-section" id="res-section">
            <span class="export-section-label">Resolution</span>
            <div class="res-grid" id="res-group">
              ${PRESETS.map(p => `
                <button class="res-card${p.id === '1080p' ? ' res-card--on' : ''}"
                        data-res="${p.id}"
                        ${p.hint ? `title="${p.hint}"` : ''}>
                  <div class="res-preview res-preview--${p.aspect}" aria-hidden="true"></div>
                  <div class="res-card-label">${p.label}</div>
                  <div class="res-card-dim">${p.dim}</div>
                </button>
              `).join('')}
            </div>
          </section>

          <section class="export-section" id="fps-section">
            <span class="export-section-label">Frame rate</span>
            <div class="fps-group" id="fps-group">
              <button class="fps-btn" data-fps="24">24 fps</button>
              <button class="fps-btn fps-btn--on" data-fps="30">30 fps</button>
              <button class="fps-btn" data-fps="60">60 fps</button>
            </div>
          </section>

          <div class="export-actions">
            <button class="modal-btn" id="ep-cancel-settings">Cancel</button>
            <button class="modal-btn modal-btn--accent" id="ep-start">
              ${ICON_EXPORT_ARROW}
              <span>Export</span>
            </button>
          </div>
        </div>

        <div class="export-phase hidden" id="ep-progress">
          <div class="export-spinner"></div>
          <div class="export-stage" id="ep-stage">Preparing…</div>
          <div class="export-progress-wrap">
            <div class="export-progress-bar" id="ep-bar"></div>
          </div>
          <div class="export-pct" id="ep-pct">0%</div>
          <button class="modal-btn" id="ep-cancel-progress">Cancel</button>
        </div>

      </div>
    `
    container.appendChild(this.el)
    this.bindEvents()
  }

  private bindEvents(): void {
    this.settingsPhase = this.el.querySelector('#ep-settings')!
    this.progressPhase = this.el.querySelector('#ep-progress')!
    this.progressBar   = this.el.querySelector('#ep-bar')!
    this.stageEl       = this.el.querySelector('#ep-stage')!
    this.pctEl         = this.el.querySelector('#ep-pct')!

    this.el.querySelectorAll<HTMLButtonElement>('#fps-group .fps-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('#fps-group .fps-btn').forEach(b => b.classList.remove('fps-btn--on'))
        btn.classList.add('fps-btn--on')
        this.selectedFps = parseInt(btn.dataset['fps']!, 10)
      })
    })

    this.el.querySelectorAll<HTMLButtonElement>('#res-group .res-card').forEach(btn => {
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('#res-group .res-card').forEach(b => b.classList.remove('res-card--on'))
        btn.classList.add('res-card--on')
        this.selectedResolution = btn.dataset['res'] as ExportResolution
      })
    })

    // Output selector — disables resolution + frame rate when audio-only.
    this.el.querySelectorAll<HTMLButtonElement>('#out-group .fps-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.el.querySelectorAll('#out-group .fps-btn').forEach(b => b.classList.remove('fps-btn--on'))
        btn.classList.add('fps-btn--on')
        this.selectedOutput = btn.dataset['out'] as ExportOutput
        this.applyOutputMode()
      })
    })

    this.el.querySelector('#ep-start')!.addEventListener('click', () => {
      this.showPhase('progress')
      this.onStart?.({
        fps: this.selectedFps,
        resolution: this.selectedResolution,
        output: this.selectedOutput,
      })
    })

    this.el.querySelector('#ep-cancel-settings')!.addEventListener('click', () => this.close())
    this.el.querySelector('#ep-cancel-progress')!.addEventListener('click', () => this.onCancel?.())

    // Click backdrop (settings phase only) → close
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el && this.phase === 'settings') this.close()
    })
  }

  open(): void {
    this.showPhase('settings')
    this.progressBar.style.width = '0%'
    this.pctEl.textContent = '0%'
    this.stageEl.textContent = 'Preparing…'
    this.el.classList.add('open')
  }

  close(): void {
    this.el.classList.remove('open')
  }

  updateProgress(stage: ExportStage, pct: number): void {
    this.progressBar.style.width = `${Math.round(pct * 100)}%`
    this.stageEl.textContent = `${stage}…`
    this.pctEl.textContent = `${Math.round(pct * 100)}%`
  }

  private showPhase(phase: 'settings' | 'progress'): void {
    this.phase = phase
    this.settingsPhase.classList.toggle('hidden', phase !== 'settings')
    this.progressPhase.classList.toggle('hidden', phase !== 'progress')
  }

  // Toggles visual disable on resolution + frame rate when audio-only is
  // picked. The actual encoder behavior is driven by `selectedOutput` in the
  // settings payload; this is purely UX feedback.
  private applyOutputMode(): void {
    const audioOnly = this.selectedOutput === 'audio-only'
    this.el.querySelector('#res-section')?.classList.toggle('export-section--disabled', audioOnly)
    this.el.querySelector('#fps-section')?.classList.toggle('export-section--disabled', audioOnly)
  }
}

const ICON_FILM = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="4" width="20" height="16" rx="2.5"/>
  <line x1="2" y1="9"  x2="22" y2="9"/>
  <line x1="2" y1="15" x2="22" y2="15"/>
  <line x1="7" y1="4"  x2="7"  y2="20"/>
  <line x1="17" y1="4" x2="17" y2="20"/>
</svg>`

const ICON_EXPORT_ARROW = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 3v12"/>
  <polyline points="7 8 12 3 17 8"/>
  <rect x="3" y="15" width="18" height="6" rx="1.5"/>
</svg>`
