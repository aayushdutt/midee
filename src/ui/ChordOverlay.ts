import type { ChordReading } from '../core/music/ChordDetector'

// Inline chord readout — lives in the top strip rather than as a floating
// card, so it sits as a quiet supplementary cue beside the now-playing
// status pill instead of grabbing focus from the canvas. Toggled visible
// via the topbar Chord button.
export class ChordOverlay {
  private root: HTMLElement
  private tonicEl: HTMLElement
  private qualityEl: HTMLElement
  private visible = false
  private lastSignature = ''
  // Hold-over timer so a momentary gap (legato release between chords)
  // doesn't collapse the readout to "—" for a single frame and flash.
  private clearTimer: ReturnType<typeof setTimeout> | null = null

  constructor(slot: HTMLElement) {
    this.root = document.createElement('span')
    this.root.id = 'ts-chord-readout'
    this.root.className = 'ts-chord-readout'
    this.root.setAttribute('role', 'status')
    this.root.setAttribute('aria-live', 'polite')
    this.root.setAttribute('aria-label', 'Currently sounding chord')
    this.root.innerHTML = `
      <span class="ts-chord-readout-name">
        <span class="ts-chord-readout-tonic" data-role="tonic">—</span><span class="ts-chord-readout-quality" data-role="quality"></span>
      </span>
    `
    slot.appendChild(this.root)
    this.tonicEl = this.root.querySelector<HTMLElement>('[data-role="tonic"]')!
    this.qualityEl = this.root.querySelector<HTMLElement>('[data-role="quality"]')!
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.root.classList.toggle('ts-chord-readout--on', visible)
    if (!visible) {
      this.lastSignature = ''
      this.cancelClearTimer()
    }
  }

  get isVisible(): boolean {
    return this.visible
  }

  // Push a new reading. No-op when hidden — saves DOM thrash on every frame
  // when the user has the readout turned off.
  update(reading: ChordReading): void {
    if (!this.visible) return

    const sig = reading.name ?? reading.pitchClasses.join('·')
    if (sig === this.lastSignature) return

    // Empty reading: defer the visual reset by ~140ms so brief silences
    // between chord changes don't blink the readout.
    if (sig === '') {
      if (this.clearTimer) return
      this.clearTimer = setTimeout(() => {
        this.applyReading(EMPTY_READING)
        this.lastSignature = ''
        this.clearTimer = null
      }, 140)
      return
    }

    this.cancelClearTimer()
    this.applyReading(reading)
    this.lastSignature = sig
  }

  private applyReading(r: ChordReading): void {
    const empty = !r.name && r.pitchClasses.length === 0
    this.root.classList.toggle('ts-chord-readout--empty', empty)
    // Force-restart the entry animation so each chord change reads as a
    // small beat. Toggle the class off first, then re-add.
    this.root.classList.remove('ts-chord-readout--pulse')
    void this.root.offsetWidth
    this.root.classList.add('ts-chord-readout--pulse')

    if (empty) {
      this.tonicEl.textContent = '—'
      this.qualityEl.textContent = ''
      return
    }

    if (r.name) {
      this.tonicEl.textContent = formatTonic(r.tonic ?? r.name)
      this.qualityEl.innerHTML = formatQualityHtml(r.quality ?? '')
      return
    }

    // No chord matched — show the pitch classes joined as a fallback.
    this.tonicEl.textContent = r.pitchClasses.map(formatTonic).join('·')
    this.qualityEl.textContent = ''
  }

  private cancelClearTimer(): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer)
      this.clearTimer = null
    }
  }

  dispose(): void {
    this.cancelClearTimer()
    this.root.remove()
  }
}

const EMPTY_READING: ChordReading = {
  name: null,
  tonic: null,
  quality: null,
  pitchClasses: [],
}

// Replace ASCII accidentals with proper musical glyphs so the readout looks
// typographically right ("F♯" not "F#").
function formatTonic(s: string): string {
  return s.replace(/#/g, '♯').replace(/b/g, '♭')
}

// The quality string carries minor sevenths, sus4s, slash bass, etc. Render
// the "/Bass" portion in a softer color so inversions read at a glance.
function formatQualityHtml(quality: string): string {
  if (!quality) return ''
  const slashIdx = quality.indexOf('/')
  if (slashIdx < 0) return escapeHtml(formatTonic(quality))
  const head = quality.slice(0, slashIdx)
  const tail = quality.slice(slashIdx + 1)
  return `${escapeHtml(formatTonic(head))}<span class="ts-chord-readout-bass">/${escapeHtml(formatTonic(tail))}</span>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c))
}
