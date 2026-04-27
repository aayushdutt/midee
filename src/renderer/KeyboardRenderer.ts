import type { Application } from 'pixi.js'
import { Container, Graphics, RenderTexture, Sprite, Texture, TilingSprite } from 'pixi.js'
import { isBlackKey, MIDI_MAX, MIDI_MIN } from '../core/midi/types'
import type { Theme } from './theme'
import type { Viewport } from './viewport'

// The static keyboard base is split into two RenderTextures — a white-keys
// sprite and a black-keys sprite — with the active-key overlay sandwiched
// between them. This lets a pressed white key's color be naturally clipped
// by any black keys sitting on top: the overlay draws on top of the white
// sprite, and the black sprite renders on top of the overlay, covering the
// occluded portions for free via z-order. No masks, no polygon math.
//
// Z-order (bottom → top):
//   1. whiteSprite       — bg + whites + depth + ivory wash + noise
//   2. whiteActiveLayer  — per-frame: tinted overlay for pressed white keys
//   3. blackSprite       — blacks + bevels + rails
//   4. blackActiveLayer  — per-frame: tinted overlay for pressed black keys

// Convert a CSS-style hex color (`#abcdef` / `#abc`) into a Pixi 0xRRGGBB
// number. Returns null on parse failure so callers can fall back.
function parseHexColor(s: string): number | null {
  const m = s.trim().match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  if (!m) return null
  let hex = m[1]!
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const n = parseInt(hex, 16)
  return Number.isFinite(n) ? n : null
}

// One 96×96 greyscale noise tile is enough — it tiles imperceptibly
// across 88 keys. Cached at module scope so theme rebuilds don't
// re-roll the RNG (would cause visible shimmer across theme cycles).
let ivoryNoiseCanvas: HTMLCanvasElement | null = null
function getIvoryNoiseCanvas(): HTMLCanvasElement {
  if (ivoryNoiseCanvas) return ivoryNoiseCanvas
  const size = 96
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let i = 0; i < img.data.length; i += 4) {
    // Bias brightness high so the grain reads as "ivory", not "static".
    // Alpha is ~8% — subtle but visible on close look.
    const v = 200 + Math.random() * 55
    img.data[i] = v
    img.data[i + 1] = v
    img.data[i + 2] = v
    img.data[i + 3] = 20
  }
  ctx.putImageData(img, 0, 0)
  ivoryNoiseCanvas = c
  return c
}

export class KeyboardRenderer {
  readonly container: Container

  // Static baked layers
  private whiteSprite: Sprite | null = null
  private whiteTexture: RenderTexture | null = null
  private blackSprite: Sprite | null = null
  private blackTexture: RenderTexture | null = null

  // Per-frame active overlays — one per key colour (white vs black) so we
  // can insert the black sprite between them for automatic clipping.
  private whiteActiveLayer: Graphics
  private blackActiveLayer: Graphics

  // Persistent practice-mode hint layers. White-key hints sit below the baked
  // black-key sprite so black keys naturally occlude neighboring white halos;
  // black-key hints sit above the black sprite. This mirrors the active-key
  // z-stack and avoids masks.
  private whitePracticeHintLayer: Graphics
  private blackPracticeHintLayer: Graphics
  private practiceSignature = ''
  private practicePulsePhase = 0
  private practiceTickerHandler: ((ticker: import('pixi.js').Ticker) => void) | null = null
  private practicePending: ReadonlySet<number> | null = null
  private practiceAccepted: ReadonlySet<number> | null = null
  private practiceTheme: Theme | null = null

  // Snapshot of the last-drawn pitch→color map as a single signature string.
  // If nothing changed we skip the clear + redraw entirely (common during
  // sustained chords and idle frames).
  private lastSignature = ''
  private activeLayerDirty = true
  // Signature of the last baked-texture inputs (size + key positions + theme
  // colors). Used to short-circuit build() when nothing that affects the
  // baked RenderTextures has actually changed — skips a texture destroy/
  // recreate that would otherwise stall the GPU on every theme re-apply.
  private lastBuildSignature = ''

  constructor(
    private app: Application,
    private theme: Theme,
  ) {
    this.container = new Container()
    this.container.label = 'keyboard'

    this.whiteActiveLayer = new Graphics()
    this.whiteActiveLayer.label = 'keyboard-active-white'
    this.blackActiveLayer = new Graphics()
    this.blackActiveLayer.label = 'keyboard-active-black'
    this.whitePracticeHintLayer = new Graphics()
    this.whitePracticeHintLayer.label = 'keyboard-practice-hint-white'
    this.blackPracticeHintLayer = new Graphics()
    this.blackPracticeHintLayer.label = 'keyboard-practice-hint-black'
    // Order matters: white hints/active must sit above the white sprite but
    // below the black sprite. Black hints/active sit above the black sprite.
    // Sprites are inserted by build() at the correct indices.
    this.container.addChild(this.whitePracticeHintLayer)
    this.container.addChild(this.whiteActiveLayer)
    this.container.addChild(this.blackPracticeHintLayer)
    this.container.addChild(this.blackActiveLayer)
  }

  // Build or rebuild the static keyboard textures.
  // Call on init and whenever the canvas is resized.
  build(viewport: Viewport, yOffset: number): void {
    const { keyboardHeight, canvasWidth, pitchMin, pitchMax } = viewport.config
    const positions = viewport.getAllKeyPositions()
    // Snapshot for the practice-hint layer (which redraws on its own ticker
    // and doesn't otherwise have a Viewport reference handy).
    this.lastPositions = new Map(positions)

    // Skip the destroy+re-bake when every input to the bake is unchanged. All
    // the baked pixels depend on: canvas width, keyboard height, the pitch
    // range (which determines key positions), and the three theme colours
    // that tint the white/black keys and gap. Hitting this cache path turns
    // a theme re-apply or redundant rebuildStaticLayers() into a no-op.
    const sig =
      `${canvasWidth}x${keyboardHeight}|${pitchMin ?? 21}-${pitchMax ?? 108}|` +
      `${this.theme.whiteKey}.${this.theme.blackKey}.${this.theme.keyBorder}|y=${yOffset}`
    if (sig === this.lastBuildSignature && this.whiteSprite && this.blackSprite) {
      // Positions may still need to be re-cached if the caller swapped the
      // Viewport instance — but sig encodes every positional input, so
      // referential equality is fine here too.
      if (!this.lastPositions) this.lastPositions = new Map(positions)
      return
    }
    this.lastBuildSignature = sig

    // Snapshot for the practice-hint layer (which redraws on its own ticker
    // and doesn't otherwise have a Viewport reference handy).
    this.lastPositions = new Map(positions)

    // Destroy previous textures/sprites to avoid memory leaks. destroy()
    // also removes the sprite from its parent container.
    this.whiteTexture?.destroy()
    this.whiteSprite?.destroy()
    this.blackTexture?.destroy()
    this.blackSprite?.destroy()

    // ─── White bake ──────────────────────────────────────────────────
    // bg + white keys + depth cues + ivory wash + ivory grain noise.
    const whiteBake = new Container()

    // Background fill (shows through the 1px seams between white keys)
    const bg = new Graphics()
    bg.rect(0, 0, canvasWidth, keyboardHeight).fill({ color: this.theme.blackKey })
    whiteBake.addChild(bg)

    // White keys: body + ivory warmth + lighting depth.
    const whiteLayer = new Graphics()
    const wMargin = 1
    const wRadius = 3
    for (let p = MIDI_MIN; p <= MIDI_MAX; p++) {
      if (isBlackKey(p)) continue
      const pos = positions.get(p)
      if (!pos) continue
      const x = pos.x + wMargin
      const y = 2
      const w = pos.width - wMargin * 2
      const h = keyboardHeight - 4

      // Body
      whiteLayer.roundRect(x, y, w, h, wRadius).fill({ color: this.theme.whiteKey })

      // Ivory warmth wash — pure white keys read sterile; real ivory has a
      // cream undertone. A ~4% cream overlay shifts the whole material
      // toward "instrument" without tinting any one area obviously.
      whiteLayer.roundRect(x, y, w, h, wRadius).fill({ color: 0xfff1d8, alpha: 0.05 })

      // Top highlight — 4px, stacked rects simulate a soft gradient. Inset
      // by the corner radius so the highlight respects the key's rounded
      // corners and doesn't bleed into the seam between keys.
      whiteLayer.rect(x + wRadius, y, w - wRadius * 2, 1).fill({ color: 0xffffff, alpha: 0.35 })
      whiteLayer.rect(x + 1, y + 1, w - 2, 2).fill({ color: 0xffffff, alpha: 0.18 })
      whiteLayer.rect(x + 1, y + 3, w - 2, 2).fill({ color: 0xffffff, alpha: 0.08 })

      // Bottom shadow — 5px, three stacked rects fading into a strong 1px
      // edge line. Gives each key the "slightly dipped at the player's
      // edge" read you'd see on a real piano under stage lighting.
      whiteLayer.rect(x + 1, y + h - 5, w - 2, 3).fill({ color: 0x000000, alpha: 0.07 })
      whiteLayer.rect(x + 1, y + h - 2, w - 2, 1).fill({ color: 0x000000, alpha: 0.18 })
      whiteLayer
        .rect(x + wRadius, y + h - 1, w - wRadius * 2, 1)
        .fill({ color: 0x000000, alpha: 0.3 })
    }
    whiteBake.addChild(whiteLayer)

    // Ivory grain — tiled from a 96×96 noise canvas. Only appears on white
    // keys; the dark inter-key seams absorb it to invisibility against
    // the near-black bg.
    const noiseTex = Texture.from(getIvoryNoiseCanvas())
    const noise = new TilingSprite({
      texture: noiseTex,
      width: canvasWidth,
      height: keyboardHeight,
    })
    whiteBake.addChild(noise)

    this.whiteTexture = RenderTexture.create({ width: canvasWidth, height: keyboardHeight })
    this.app.renderer.render({ container: whiteBake, target: this.whiteTexture })
    whiteBake.destroy({ children: true })
    noiseTex.destroy(true)

    // ─── Black bake ──────────────────────────────────────────────────
    // Black keys + bevels + rails. Transparent background so the active
    // overlay below can show through inter-black-key gaps.
    const blackBake = new Container()
    const blackLayer = new Graphics()
    const bRadius = 2
    const blackHeight = keyboardHeight * 0.62
    for (let p = MIDI_MIN; p <= MIDI_MAX; p++) {
      if (!isBlackKey(p)) continue
      const pos = positions.get(p)
      if (!pos) continue
      const x = pos.x
      const y = 0
      const w = pos.width
      const h = blackHeight

      // Body
      blackLayer.roundRect(x, y, w, h, bRadius).fill({ color: this.theme.blackKey })

      // Top bevel — hints at the rounded physical top of a real black key.
      blackLayer.rect(x + bRadius, y, w - bRadius * 2, 1).fill({ color: 0xffffff, alpha: 0.28 })
      blackLayer.rect(x + 1, y + 1, w - 2, 2).fill({ color: 0xffffff, alpha: 0.12 })

      // Bottom lip — where the finger rests on a physical piano. A thin
      // bright edge catches light and sells the 3D form cheaply.
      blackLayer.rect(x + 1, y + h - 3, w - 2, 2).fill({ color: 0xffffff, alpha: 0.1 })
      blackLayer
        .rect(x + bRadius, y + h - 1, w - bRadius * 2, 1)
        .fill({ color: 0xffffff, alpha: 0.22 })

      // Side-edge rails — reflective highlights along the left and right
      // edges, running the full length. Directional asymmetry (left
      // brighter than right) sells a light source from the upper-left.
      const railY = y + bRadius
      const railH = h - bRadius * 2
      // Left rail (toward the light source)
      blackLayer.rect(x, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.44 })
      blackLayer.rect(x + 1, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.2 })
      // Right rail (opposite side, dimmer)
      blackLayer.rect(x + w - 1, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.28 })
      blackLayer.rect(x + w - 2, railY, 1, railH).fill({ color: 0xffffff, alpha: 0.12 })
    }
    blackBake.addChild(blackLayer)

    this.blackTexture = RenderTexture.create({ width: canvasWidth, height: keyboardHeight })
    this.app.renderer.render({ container: blackBake, target: this.blackTexture })
    blackBake.destroy({ children: true })

    // ─── Assemble the z-stack ────────────────────────────────────────
    // After the destroys above, the container holds only the four overlay
    // layers. Reinsert the sprites
    // at the correct indices so the final order is:
    //   whiteSprite, whitePracticeHintLayer, whiteActiveLayer,
    //   blackSprite, blackPracticeHintLayer, blackActiveLayer
    this.whiteSprite = new Sprite(this.whiteTexture)
    this.whiteSprite.y = yOffset
    this.container.addChildAt(this.whiteSprite, 0)

    this.blackSprite = new Sprite(this.blackTexture)
    this.blackSprite.y = yOffset
    // Insert blackSprite between the white overlays and black overlays.
    this.container.addChildAt(this.blackSprite, 3)

    this.whitePracticeHintLayer.y = yOffset
    this.whiteActiveLayer.y = yOffset
    this.blackPracticeHintLayer.y = yOffset
    this.blackActiveLayer.y = yOffset
    // Force a redraw of the hint layer on the next setPracticeHints call —
    // the geometry depends on the freshly-built viewport.
    this.practiceSignature = ''
  }

  // Called every frame — draws only the keys that are currently pressed, each
  // tinted with the color of the track/source it came from. Routes white and
  // black presses to separate Graphics layers so the black static sprite can
  // clip the white overlay by sitting on top of it in the z-stack.
  drawActiveKeys(activeByPitch: Map<number, number>, viewport: Viewport): void {
    const sig = this.signatureFor(activeByPitch)
    if (!this.activeLayerDirty && sig === this.lastSignature) return
    this.activeLayerDirty = false
    this.lastSignature = sig
    this.whiteActiveLayer.clear()
    this.blackActiveLayer.clear()

    const { keyboardHeight } = viewport.config
    const positions = viewport.getAllKeyPositions()
    const fallback = this.theme.trackColors[0] ?? this.theme.nowLine

    // Halos drawn first (so the solid body sits on top).
    const halos: readonly [number, number][] = [
      [10, 0.05],
      [6, 0.1],
      [3, 0.18],
    ]
    for (const [pitch, color] of activeByPitch) {
      const pos = positions.get(pitch)
      if (!pos) continue
      const tint = color || fallback
      const isBlack = isBlackKey(pitch)
      const layer = isBlack ? this.blackActiveLayer : this.whiteActiveLayer
      const h = isBlack ? keyboardHeight * 0.62 : keyboardHeight - 4
      const margin = isBlack ? 0 : 1
      const x = pos.x + margin
      const w = pos.width - margin * 2
      const y = isBlack ? 0 : 2
      const radius = isBlack ? 2 : 3

      for (const [expand, alpha] of halos) {
        layer.roundRect(x - expand, y - expand, w + expand * 2, h + expand * 2, radius + expand)
        layer.fill({ color: tint, alpha })
      }

      // Body — exact static-key shape so the active state lives inside the key's border.
      layer.roundRect(x, y, w, h, radius)
      layer.fill({ color: tint, alpha: isBlack ? 0.92 : 0.78 })
    }
  }

  updateTheme(theme: Theme): void {
    this.theme = theme
    // Colors baked into the active-key fill changed — force a redraw.
    this.activeLayerDirty = true
    // Practice hint colours follow the active theme accent.
    this.practiceTheme = theme
    this.practiceSignature = ''
  }

  // Public hook for the parent renderer to swap in the current practice-mode
  // hint. Pass `null` to clear. The pulse animation runs on a private ticker so
  // the hint breathes even on frames where the main render loop is idle (file
  // playback paused, no live notes pending).
  setPracticeHints(
    pending: ReadonlySet<number> | null,
    accepted: ReadonlySet<number> | null,
    theme: Theme,
  ): void {
    this.practicePending = pending
    this.practiceAccepted = accepted
    this.practiceTheme = theme
    const sig = this.hintSignature(pending, accepted)
    if (sig !== this.practiceSignature) {
      this.practiceSignature = sig
      this.drawPracticeHints()
    }

    const wantTicker = !!pending && pending.size > 0
    if (wantTicker && !this.practiceTickerHandler) {
      this.practiceTickerHandler = (ticker) => {
        // ticker.deltaTime is Pixi units (~1 per 16.6ms). Scale to a slow
        // pulse — about one full breath every 1.4 seconds.
        this.practicePulsePhase += ticker.deltaTime * 0.075
        this.drawPracticeHints()
      }
      this.app.ticker.add(this.practiceTickerHandler)
    } else if (!wantTicker && this.practiceTickerHandler) {
      this.app.ticker.remove(this.practiceTickerHandler)
      this.practiceTickerHandler = null
      this.practicePulsePhase = 0
      this.drawPracticeHints()
    }
  }

  private drawPracticeHints(): void {
    this.whitePracticeHintLayer.clear()
    this.blackPracticeHintLayer.clear()
    const pending = this.practicePending
    const accepted = this.practiceAccepted
    if ((!pending || pending.size === 0) && (!accepted || accepted.size === 0)) return
    const theme = this.practiceTheme ?? this.theme
    const yOffset = this.whiteSprite?.y ?? 0
    const totalH = this.whiteSprite?.height ?? 0
    if (totalH === 0) return

    // Pulse: 0..1 sine, normalised so even when the user has played part of
    // the chord the remaining keys keep a strong baseline glow.
    const pulse = 0.55 + 0.45 * Math.abs(Math.sin(this.practicePulsePhase))

    // Use the exact key positions captured during the latest static keyboard
    // build so hint geometry matches the baked sprites.
    const positions = this.lastPositions
    if (!positions) return

    this.whitePracticeHintLayer.y = yOffset
    this.blackPracticeHintLayer.y = yOffset
    const accent = theme.uiAccentCSS
    const tint = parseHexColor(accent) ?? theme.trackColors[0] ?? theme.nowLine
    const acceptedTint = 0x9ee7b8
    const fullKbHeight = totalH

    if (accepted) {
      for (const pitch of accepted) {
        const pos = positions.get(pitch)
        if (!pos) continue
        const layer = isBlackKey(pitch) ? this.blackPracticeHintLayer : this.whitePracticeHintLayer
        this.drawPracticeKey(layer, pitch, pos, fullKbHeight, acceptedTint, {
          bodyAlpha: isBlackKey(pitch) ? 0.36 : 0.25,
          stripAlpha: 0.58,
          haloScale: 0.55,
        })
      }
    }

    if (!pending) return
    for (const pitch of pending) {
      const pos = positions.get(pitch)
      if (!pos) continue
      const isBlack = isBlackKey(pitch)
      const layer = isBlack ? this.blackPracticeHintLayer : this.whitePracticeHintLayer
      this.drawPracticeKey(layer, pitch, pos, fullKbHeight, tint, {
        bodyAlpha: (isBlack ? 0.32 : 0.22) * pulse,
        stripAlpha: 0.55 * pulse,
        haloScale: pulse,
      })
    }
  }

  private drawPracticeKey(
    layer: Graphics,
    pitch: number,
    pos: { x: number; width: number },
    fullKbHeight: number,
    tint: number,
    opts: { bodyAlpha: number; stripAlpha: number; haloScale: number },
  ): void {
    const x = pos.x
    const w = pos.width
    const isBlack = isBlackKey(pitch)
    const h = isBlack ? fullKbHeight * 0.62 : fullKbHeight - 4
    const y = isBlack ? 0 : 2
    const radius = isBlack ? 2 : 3

    const halos: readonly [number, number][] = [
      [12, 0.05 * opts.haloScale],
      [7, 0.1 * opts.haloScale],
      [3, 0.18 * opts.haloScale],
    ]
    for (const [expand, alpha] of halos) {
      layer.roundRect(x - expand, y - expand, w + expand * 2, h + expand * 2, radius + expand)
      layer.fill({ color: tint, alpha })
    }

    layer.roundRect(x, y, w, h, radius)
    layer.fill({ color: tint, alpha: opts.bodyAlpha })

    layer.rect(x + radius, y, w - radius * 2, 2)
    layer.fill({ color: tint, alpha: opts.stripAlpha })
  }

  private hintSignature(
    pending: ReadonlySet<number> | null,
    accepted: ReadonlySet<number> | null,
  ): string {
    const p = pending ? Array.from(pending).sort().join('.') : ''
    const a = accepted ? Array.from(accepted).sort().join('.') : ''
    return `${p}|${a}`
  }

  // Cached so practice-hints can render without reaching back into Viewport.
  // Captured during `build()` from the same Viewport instance.
  private lastPositions: Map<number, { x: number; width: number }> | null = null

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
