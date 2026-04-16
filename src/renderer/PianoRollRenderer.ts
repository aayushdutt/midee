import { Application, Graphics, Ticker } from 'pixi.js'
import type { MidiFile } from '../core/midi/types'
import type { MasterClock } from '../core/clock/MasterClock'
import { NoteRenderer } from './NoteRenderer'
import { KeyboardRenderer } from './KeyboardRenderer'
import { LiveNoteRenderer } from './LiveNoteRenderer'
import { ParticleSystem } from './ParticleSystem'
import { BeatGrid } from './BeatGrid'
import { Viewport } from './viewport'
import { darkTheme, getTrackColor, type Theme } from './theme'
import type { LiveNoteStore } from '../midi/LiveNoteStore'

const DEFAULT_KEYBOARD_HEIGHT = 120
export const KEYBOARD_HEIGHT_MIN = 80
export const KEYBOARD_HEIGHT_MAX = 220
const DEFAULT_PIXELS_PER_SECOND = 200

export class PianoRollRenderer {
  private app!: Application
  private viewport!: Viewport
  private noteRenderer!: NoteRenderer
  private keyboardRenderer!: KeyboardRenderer
  private liveNoteRenderer!: LiveNoteRenderer
  private particles!: ParticleSystem
  private beatGrid!: BeatGrid
  private nowLineGraphics!: Graphics
  private backgroundGraphics!: Graphics

  private midi: MidiFile | null = null
  private liveNoteStore: LiveNoteStore | null = null
  private visibleTrackIds = new Set<string>()
  private theme: Theme = darkTheme
  private pixelsPerSecond = DEFAULT_PIXELS_PER_SECOND
  private keyboardHeight = DEFAULT_KEYBOARD_HEIGHT

  // Two pooled Sets swapped each frame. Keys are packed `trackIndex * 128 + pitch`
  // so comparisons never allocate strings in the hot path.
  private prevActive = new Set<number>()
  private currActive = new Set<number>()
  private activePitchNums = new Set<number>()
  private exportMode = false

  async init(canvas: HTMLCanvasElement): Promise<void> {
    this.app = new Application()

    await this.app.init({
      canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: darkTheme.background,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    })

    this.viewport = new Viewport({
      canvasWidth: this.app.screen.width,
      canvasHeight: this.app.screen.height,
      keyboardHeight: this.keyboardHeight,
      pixelsPerSecond: this.pixelsPerSecond,
    })

    this.buildScene()
    this.handleResize()

    window.addEventListener('resize', this.handleResize)
  }

  private buildScene(): void {
    const stage = this.app.stage

    // Layer order (bottom → top):
    // 1. background  2. beat-grid  3. notes  4. live-notes  5. now-line  6. keyboard  7. particles

    this.backgroundGraphics = new Graphics()
    this.backgroundGraphics.label = 'background'
    stage.addChild(this.backgroundGraphics)

    this.beatGrid = new BeatGrid()
    stage.addChild(this.beatGrid.graphics)

    this.noteRenderer = new NoteRenderer(this.theme)
    stage.addChild(this.noteRenderer.container)

    this.liveNoteRenderer = new LiveNoteRenderer(this.theme)
    stage.addChild(this.liveNoteRenderer.container)

    this.nowLineGraphics = new Graphics()
    this.nowLineGraphics.label = 'now-line'
    stage.addChild(this.nowLineGraphics)

    this.keyboardRenderer = new KeyboardRenderer(this.app, this.theme)
    stage.addChild(this.keyboardRenderer.container)

    this.particles = new ParticleSystem()
    stage.addChild(this.particles.container)

    this.rebuildStaticLayers()
  }

  // Redraw every layer whose contents don't change per frame: background, now-line,
  // keyboard texture. Follow with `renderStaticFrame()` if the current frame also
  // needs to be re-presented.
  private rebuildStaticLayers(): void {
    this.drawBackground()
    this.drawNowLine()
    this.keyboardRenderer.build(this.viewport, this.viewport.rollHeight)
  }

  private drawBackground(): void {
    const { canvasWidth, canvasHeight } = this.viewport.config
    const rollHeight = this.viewport.rollHeight
    const g = this.backgroundGraphics
    g.clear()

    g.rect(0, 0, canvasWidth, canvasHeight)
    g.fill({ color: this.theme.background })

    // Subtle vertical lines at C notes
    for (let pitch = 24; pitch <= 108; pitch += 12) {
      const x = this.viewport.pitchToX(pitch)
      g.rect(x, 0, 1, rollHeight)
      g.fill({ color: 0xffffff, alpha: 0.025 })
    }

    // Separator line between roll and keyboard
    g.rect(0, rollHeight, canvasWidth, 1)
    g.fill({ color: this.theme.keyBorder })
  }

  private drawNowLine(): void {
    const g = this.nowLineGraphics
    g.clear()
    const y = this.viewport.nowLineY
    const w = this.viewport.config.canvasWidth
    const glow = this.theme.nowLineGlow

    // Layered soft glow above the now-line
    g.rect(0, y - 14, w, 14); g.fill({ color: glow, alpha: 0.010 })
    g.rect(0, y - 8,  w, 8);  g.fill({ color: glow, alpha: 0.022 })
    g.rect(0, y - 4,  w, 4);  g.fill({ color: glow, alpha: 0.040 })
    g.rect(0, y - 2,  w, 2);  g.fill({ color: glow, alpha: 0.065 })

    g.rect(0, y, w, 1.5)
    g.fill({ color: this.theme.nowLine, alpha: this.theme.nowLineAlpha })
  }

  loadMidi(midi: MidiFile): void {
    this.midi = midi
    this.visibleTrackIds = new Set(midi.tracks.map(t => t.id))
    this.noteRenderer.setTracks(midi.tracks)
    this.particles.clear()
    this.prevActive.clear()
    this.currActive.clear()
    this.renderStaticFrame(0)
  }

  clearMidi(): void {
    this.midi = null
    this.visibleTrackIds.clear()
    this.noteRenderer.setTracks([])
    this.noteRenderer.clear()
    this.liveNoteRenderer.clear()
    this.particles.clear()
    this.prevActive.clear()
    this.currActive.clear()
    this.beatGrid.graphics.clear()
    this.renderStaticFrame(0)
  }

  setTrackVisible(trackId: string, visible: boolean): void {
    if (visible) this.visibleTrackIds.add(trackId)
    else this.visibleTrackIds.delete(trackId)
  }

  setZoom(pixelsPerSecond: number): void {
    this.pixelsPerSecond = pixelsPerSecond
    // Key layout and keyboard texture are width-dependent, not zoom-dependent —
    // no need to rebuild them when only pixelsPerSecond changes.
    this.viewport.update({ pixelsPerSecond })
  }

  setKeyboardHeight(px: number): void {
    const clamped = Math.max(KEYBOARD_HEIGHT_MIN, Math.min(KEYBOARD_HEIGHT_MAX, Math.round(px)))
    if (clamped === this.keyboardHeight) return
    this.keyboardHeight = clamped
    this.viewport.update({ keyboardHeight: clamped })
    document.documentElement.style.setProperty('--keyboard-h', `${clamped}px`)
    this.rebuildStaticLayers()
    this.renderStaticFrame(0)
  }

  get currentKeyboardHeight(): number {
    return this.keyboardHeight
  }

  setTheme(theme: Theme): void {
    this.theme = theme
    this.app.renderer.background.color = theme.background
    this.noteRenderer.updateTheme(theme)
    this.liveNoteRenderer.updateTheme(theme)
    this.keyboardRenderer.updateTheme(theme)
    this.rebuildStaticLayers()
    this.renderStaticFrame(0)
  }

  attachClock(clock: MasterClock): void {
    this.app.ticker.add(this.onTick.bind(this, clock))
  }

  private onTick(clock: MasterClock, ticker: Ticker): void {
    if (this.exportMode) return
    const hasLive = this.liveNoteStore?.hasRenderableNotes ?? false
    if (!this.midi && !hasLive) return
    this.renderFrame(clock.currentTime, ticker.deltaMS / 1000, clock.playing)
  }

  renderManualFrame(time: number, dt: number): void {
    if (!this.midi) return
    this.renderFrame(time, dt, false)
    this.app.renderer.render(this.app.stage)
  }

  renderStaticFrame(currentTime: number): void {
    this.renderFrame(currentTime, 0, false)
    this.app.renderer.render(this.app.stage)
  }

  private renderFrame(currentTime: number, dt: number, emitParticles: boolean): void {
    const curr = this.currActive
    const pitchNums = this.activePitchNums
    curr.clear()
    pitchNums.clear()

    // ── Scheduled MIDI notes ──────────────────────────────────────────────
    // Single pass collects active pitches and emits note-on particle bursts.
    // `prev`/`curr` swap at the end — no per-frame Set or string allocations.
    if (this.midi) {
      const tracks = this.midi.tracks
      const prev = this.prevActive
      const nowLineY = this.viewport.nowLineY

      for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti]!
        if (!this.visibleTrackIds.has(track.id)) continue
        const trackColor = emitParticles ? getTrackColor(track, this.theme) : 0
        const keyBase = ti * 128

        for (const note of track.notes) {
          if (note.time > currentTime || note.time + note.duration < currentTime) continue

          const key = keyBase + note.pitch
          curr.add(key)
          pitchNums.add(note.pitch)

          if (emitParticles && !prev.has(key)) {
            const cx = this.viewport.pitchToX(note.pitch) + this.viewport.pitchWidth(note.pitch) / 2
            this.particles.burst(cx, nowLineY, trackColor)
          }
        }
      }

      this.beatGrid.draw(currentTime, this.midi.bpm, this.midi.timeSignature[0] ?? 4, this.viewport, this.theme)
      this.noteRenderer.draw(tracks, currentTime, this.viewport, this.visibleTrackIds)
    } else {
      this.noteRenderer.clear()
    }

    // Swap prev ↔ curr for next frame (prev's contents are now stale)
    const tmp = this.prevActive
    this.prevActive = this.currActive
    this.currActive = tmp

    // ── Live MIDI keyboard notes ──────────────────────────────────────────
    if (this.liveNoteStore) {
      const maxReleasedAge = this.viewport.nowLineY / this.viewport.config.pixelsPerSecond
      this.liveNoteStore.pruneInvisible(currentTime, maxReleasedAge)

      for (const pitch of this.liveNoteStore.heldNotes.keys()) {
        pitchNums.add(pitch)
      }
      this.liveNoteRenderer.draw(this.liveNoteStore, currentTime, this.viewport)
    } else {
      this.liveNoteRenderer.clear()
    }

    this.keyboardRenderer.drawActiveKeys(pitchNums, this.viewport)
    this.particles.update(dt)
  }

  burstParticleAt(pitch: number): void {
    const cx = this.viewport.pitchToX(pitch) + this.viewport.pitchWidth(pitch) / 2
    this.particles.burst(cx, this.viewport.nowLineY, this.theme.nowLine)
  }

  setLiveNoteStore(store: LiveNoteStore): void {
    this.liveNoteStore = store
  }

  pauseAutoRender(): void {
    this.exportMode = true
    this.app.ticker.stop()
    this.particles.clear()
    this.prevActive.clear()
    this.currActive.clear()
    this.liveNoteRenderer.clear()
  }

  resumeAutoRender(): void {
    this.exportMode = false
    this.app.ticker.start()
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas as HTMLCanvasElement
  }

  // Convert a client-space (canvas) point into a MIDI pitch if it lands on a key.
  pitchAtClientPoint(clientX: number, clientY: number): number | null {
    const rect = this.app.canvas.getBoundingClientRect()
    return this.viewport.pitchAtPoint(clientX - rect.left, clientY - rect.top)
  }

  private handleResize = (): void => {
    const w = window.innerWidth
    const h = window.innerHeight
    this.app.renderer.resize(w, h)
    this.viewport.update({ canvasWidth: w, canvasHeight: h })
    this.rebuildStaticLayers()
    this.renderStaticFrame(0)
  }

  destroy(): void {
    window.removeEventListener('resize', this.handleResize)
    this.app.destroy()
  }
}
