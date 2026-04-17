import { Container, Graphics, RenderTexture, Sprite } from 'pixi.js'
import type { Application } from 'pixi.js'
import { MIDI_MIN, MIDI_MAX, isBlackKey } from '../core/midi/types'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

// The static keyboard base is rendered once into a RenderTexture.
// The active-key overlay is a regular Graphics redrawn each frame —
// but it's cheap because only a handful of keys are ever active at once.

export class KeyboardRenderer {
  readonly container: Container

  private keyboardSprite: Sprite | null = null
  private activeLayer: Graphics
  private keyboardTexture: RenderTexture | null = null

  // Snapshot of the last-drawn pitch→color map as a single signature string.
  // If nothing changed we skip the clear + redraw entirely (common during
  // sustained chords and idle frames).
  private lastSignature = ''
  private activeLayerDirty = true

  constructor(
    private app: Application,
    private theme: Theme,
  ) {
    this.container = new Container()
    this.container.label = 'keyboard'

    this.activeLayer = new Graphics()
    this.activeLayer.label = 'keyboard-active'
    this.container.addChild(this.activeLayer)
  }

  // Build or rebuild the static keyboard texture.
  // Call on init and whenever the canvas is resized.
  build(viewport: Viewport, yOffset: number): void {
    const { keyboardHeight, canvasWidth } = viewport.config
    const positions = viewport.getAllKeyPositions()

    // Destroy previous texture to avoid memory leaks
    this.keyboardTexture?.destroy()
    this.keyboardSprite?.destroy()

    const keyboardGraphics = new Graphics()

    // Background fill
    keyboardGraphics.rect(0, 0, canvasWidth, keyboardHeight)
    keyboardGraphics.fill({ color: this.theme.blackKey })

    // White keys first (drawn underneath black keys)
    for (let p = MIDI_MIN; p <= MIDI_MAX; p++) {
      if (isBlackKey(p)) continue
      const pos = positions.get(p)
      if (!pos) continue
      const margin = 1
      keyboardGraphics.roundRect(
        pos.x + margin,
        2,
        pos.width - margin * 2,
        keyboardHeight - 4,
        3,
      )
      keyboardGraphics.fill({ color: this.theme.whiteKey })
    }

    // Black keys on top
    for (let p = MIDI_MIN; p <= MIDI_MAX; p++) {
      if (!isBlackKey(p)) continue
      const pos = positions.get(p)
      if (!pos) continue
      keyboardGraphics.roundRect(
        pos.x,
        0,
        pos.width,
        keyboardHeight * 0.62,
        2,
      )
      keyboardGraphics.fill({ color: this.theme.blackKey })
    }

    // Render to texture once
    this.keyboardTexture = RenderTexture.create({ width: canvasWidth, height: keyboardHeight })
    this.app.renderer.render({ container: keyboardGraphics, target: this.keyboardTexture })
    keyboardGraphics.destroy()

    this.keyboardSprite = new Sprite(this.keyboardTexture)
    this.keyboardSprite.y = yOffset
    // Insert behind active layer
    this.container.addChildAt(this.keyboardSprite, 0)

    this.activeLayer.y = yOffset
  }

  // Called every frame — draws only the keys that are currently pressed, each
  // tinted with the color of the track/source it came from.
  drawActiveKeys(activeByPitch: Map<number, number>, viewport: Viewport): void {
    const sig = this.signatureFor(activeByPitch)
    if (!this.activeLayerDirty && sig === this.lastSignature) return
    this.activeLayerDirty = false
    this.lastSignature = sig
    this.activeLayer.clear()

    const { keyboardHeight } = viewport.config
    const positions = viewport.getAllKeyPositions()
    const fallback = this.theme.trackColors[0] ?? this.theme.nowLine

    // Halos drawn first (so the solid body sits on top).
    const halos: readonly [number, number][] = [[10, 0.05], [6, 0.10], [3, 0.18]]
    for (const [pitch, color] of activeByPitch) {
      const pos = positions.get(pitch)
      if (!pos) continue
      const tint = color || fallback
      const isBlack = isBlackKey(pitch)
      const h = isBlack ? keyboardHeight * 0.62 : keyboardHeight - 4
      const margin = isBlack ? 0 : 1
      const x = pos.x + margin
      const w = pos.width - margin * 2
      const y = isBlack ? 0 : 2
      const radius = isBlack ? 2 : 3

      for (const [expand, alpha] of halos) {
        this.activeLayer.roundRect(x - expand, y - expand, w + expand * 2, h + expand * 2, radius + expand)
        this.activeLayer.fill({ color: tint, alpha })
      }

      // Body — exact static-key shape so the active state lives inside the key's border.
      this.activeLayer.roundRect(x, y, w, h, radius)
      this.activeLayer.fill({ color: tint, alpha: isBlack ? 0.92 : 0.78 })
    }
  }

  updateTheme(theme: Theme): void {
    this.theme = theme
    // Colors baked into the active-key fill changed — force a redraw.
    this.activeLayerDirty = true
  }

  // Cheap change-detection: concatenate sorted pitch:color pairs. The map is
  // small (≤ ~10 active pitches at once) so this is essentially free and
  // catches both pitch-change and color-change in one check.
  private signatureFor(activeByPitch: Map<number, number>): string {
    if (activeByPitch.size === 0) return ''
    const parts: string[] = []
    for (const [pitch, color] of activeByPitch) parts.push(`${pitch}:${color}`)
    parts.sort()
    return parts.join(',')
  }
}
