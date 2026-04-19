import type { MidiDeviceStatus } from '../midi/MidiInputManager'
import { SamplesGrid } from './SamplesGrid'

type DropHandler = (file: File) => void
type SampleHandler = (sampleId: string) => void

function isMidiFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mid') || lower.endsWith('.midi')
}

export class DropZone {
  private el: HTMLElement
  private dragDepth = 0
  private input!: HTMLInputElement
  private statusEl!: HTMLElement
  private coarsePointerMq: MediaQueryList | null = null
  private onCoarseChange: ((e: MediaQueryListEvent) => void) | null = null

  private docDragEnter = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    this.dragDepth++
    this.el.classList.add('drag-over')
  }
  private docDragLeave = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    this.dragDepth = Math.max(0, this.dragDepth - 1)
    if (this.dragDepth === 0) this.el.classList.remove('drag-over')
  }
  private docDragOver = (e: DragEvent): void => { e.preventDefault() }
  private docDrop = (e: DragEvent): void => {
    e.preventDefault()
    this.dragDepth = 0
    this.el.classList.remove('drag-over')
    const file = e.dataTransfer?.files[0]
    if (file && isMidiFile(file.name)) this.onDrop(file)
  }

  private samples: SamplesGrid

  constructor(
    container: HTMLElement,
    private onDrop: DropHandler,
    private onLiveMode?: () => void,
    private onSample?: SampleHandler,
  ) {
    this.samples = new SamplesGrid()
    this.samples.onSelect = (id) => this.onSample?.(id)
    this.el = this.build()
    container.appendChild(this.el)
    this.bindEvents()
  }

  private build(): HTMLElement {
    const el = document.createElement('div')
    el.id = 'dropzone'
    el.innerHTML = `
      <div class="home-card">
        <span class="home-kicker">midee · MIDI visualizer</span>
        <h1 class="home-title">Play <em>notes</em>,<br/>see them bloom.</h1>
        <p class="home-sub">Open a MIDI file to animate it, or go live and play with your keyboard, mouse, or a MIDI controller.</p>

        <div class="home-actions">
          <button class="home-primary-btn" id="home-open" type="button">
            ${ICON_UPLOAD}
            <span>Open MIDI</span>
          </button>
          <button class="home-secondary-btn" id="home-live" type="button">
            ${ICON_MIDI}
            <span>Play live</span>
          </button>
        </div>

        <div class="home-samples">
          <div class="home-samples-label">or explore a sample</div>
          <div class="home-samples-mount" id="home-samples-mount"></div>
        </div>

        <div class="home-footnotes">
          <div class="home-midi-status" id="home-midi-status">Looking for MIDI…</div>
          <div class="home-drop-hint">Drop <code>.mid</code> anywhere · play with <kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>…</div>
        </div>
        <nav class="home-meta-links" aria-label="midee links">
          <a href="/blog/" class="home-meta-link" aria-label="Read the blog" title="Blog">
            ${ICON_BLOG}
          </a>
          <a href="https://github.com/aayushdutt/midee" class="home-meta-link" aria-label="Source on GitHub" title="GitHub" target="_blank" rel="noopener noreferrer">
            ${ICON_GITHUB}
          </a>
          <a href="https://discord.gg/7As2NHHd" class="home-meta-link" aria-label="Join the Discord community" title="Discord" target="_blank" rel="noopener noreferrer">
            ${ICON_DISCORD}
          </a>
        </nav>
        <input type="file" id="midi-input" accept=".mid,.midi" style="display:none" />
      </div>
    `
    this.input = el.querySelector<HTMLInputElement>('#midi-input')!
    this.statusEl = el.querySelector<HTMLElement>('#home-midi-status')!
    el.querySelector<HTMLElement>('#home-samples-mount')!.appendChild(this.samples.root)
    return el
  }

  private bindEvents(): void {
    this.input.addEventListener('change', () => {
      const file = this.input.files?.[0]
      if (file && isMidiFile(file.name)) this.onDrop(file)
      this.input.value = ''
    })

    this.el.querySelector<HTMLButtonElement>('#home-open')!.addEventListener('click', () => {
      this.openFilePicker()
    })

    const liveBtn = this.el.querySelector<HTMLButtonElement>('#home-live')!
    if (this.onLiveMode) {
      liveBtn.addEventListener('click', () => this.onLiveMode?.())
    } else {
      liveBtn.classList.add('hidden')
    }

    document.addEventListener('dragenter', this.docDragEnter)
    document.addEventListener('dragleave', this.docDragLeave)
    document.addEventListener('dragover', this.docDragOver)
    document.addEventListener('drop', this.docDrop)

    // Mirror coarse-pointer state onto the dropzone root so the CSS agent can
    // swap in a touch-optimised layout without changing our markup.
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.coarsePointerMq = window.matchMedia('(pointer: coarse)')
      this.el.classList.toggle('dropzone--touch', this.coarsePointerMq.matches)
      this.onCoarseChange = (e) => this.el.classList.toggle('dropzone--touch', e.matches)
      this.coarsePointerMq.addEventListener('change', this.onCoarseChange)
    }
  }

  updateMidiStatus(status: MidiDeviceStatus, deviceName: string): void {
    this.statusEl.dataset['midiStatus'] = status
    this.statusEl.textContent = getHomeMidiStatus(status, deviceName)
  }

  openFilePicker(): void {
    this.input.click()
  }

  show(): void {
    this.el.classList.remove('dz--hidden')
  }

  hide(): void {
    this.el.classList.add('dz--hidden')
  }

  dispose(): void {
    document.removeEventListener('dragenter', this.docDragEnter)
    document.removeEventListener('dragleave', this.docDragLeave)
    document.removeEventListener('dragover', this.docDragOver)
    document.removeEventListener('drop', this.docDrop)
    if (this.coarsePointerMq && this.onCoarseChange) {
      this.coarsePointerMq.removeEventListener('change', this.onCoarseChange)
    }
  }
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

function getHomeMidiStatus(status: MidiDeviceStatus, deviceName: string): string {
  if (status === 'connected') return deviceName || 'MIDI device ready'
  if (status === 'blocked') return 'Enable MIDI from the top bar'
  if (status === 'unavailable') return 'Web MIDI unavailable in this browser'
  return 'No MIDI device — keyboard & mouse work too'
}

const ICON_UPLOAD = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="17 8 12 3 7 8"/>
  <line x1="12" y1="3" x2="12" y2="15"/>
</svg>`

const ICON_BLOG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
  <polyline points="14 2 14 8 20 8"/>
  <line x1="8" y1="13" x2="16" y2="13"/>
  <line x1="8" y1="17" x2="13" y2="17"/>
</svg>`

const ICON_GITHUB = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M12 2C6.475 2 2 6.588 2 12.253c0 4.537 2.862 8.369 6.838 9.727.5.092.687-.222.687-.492 0-.245-.013-1.052-.013-1.912-2.512.475-3.162-.63-3.362-1.21-.113-.292-.6-1.21-1.025-1.455-.35-.192-.85-.665-.013-.677.788-.012 1.35.745 1.538 1.052.9 1.555 2.338 1.12 2.912.85.088-.665.35-1.12.638-1.376-2.225-.257-4.55-1.137-4.55-5.048 0-1.122.388-2.05 1.025-2.772-.1-.257-.45-1.31.1-2.723 0 0 .837-.272 2.75 1.06.8-.23 1.65-.345 2.5-.345s1.7.115 2.5.345c1.912-1.345 2.75-1.06 2.75-1.06.55 1.413.2 2.466.1 2.722.637.724 1.025 1.64 1.025 2.772 0 3.924-2.337 4.79-4.562 5.047.363.33.675.944.675 1.922 0 1.38-.012 2.49-.012 2.835 0 .27.188.59.688.491C19.14 20.622 22 16.777 22 12.252 22 6.588 17.525 2 12 2z"/>
</svg>`

const ICON_DISCORD = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
  <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419-.0188 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/>
</svg>`

const ICON_MIDI = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2" y="4" width="20" height="16" rx="2"/>
  <line x1="2" y1="14" x2="22" y2="14"/>
  <line x1="7" y1="4" x2="7" y2="14"/>
  <line x1="12" y1="4" x2="12" y2="14"/>
  <line x1="17" y1="4" x2="17" y2="14"/>
  <rect x="5" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
  <rect x="10" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
  <rect x="15" y="4" width="3" height="6" rx="1" fill="currentColor" stroke="none"/>
</svg>`
