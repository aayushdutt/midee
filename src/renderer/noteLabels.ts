import { BitmapFont, BitmapFontManager, BitmapText, Container, Graphics, TextStyle } from 'pixi.js'

// Pitch-class labels drawn inside the falling note bars ("E", "F♯") so a
// player on another instrument can read what's coming. Owned by NoteRenderer,
// which calls begin()/place()/end() from its existing per-frame loop — no
// second pass over the notes.
//
// Cost model: one BitmapFont (8 glyphs, rasterised once from the app's Inter
// face) and a pool of BitmapText objects reused across frames. Setting
// `.text` on a BitmapText only repositions glyph sprites, so a frame with N
// labels is N sprite updates and zero canvas rasterisation. With labels off
// the container is hidden and NoteRenderer skips every call in here.

// Sharps only: the roll has no key-signature awareness, and "F♯" is the
// spelling players on guitar/bass/voice expect from a MIDI readout.
export const PITCH_CLASS_NAMES: readonly string[] = [
  'C',
  'C♯',
  'D',
  'D♯',
  'E',
  'F',
  'F♯',
  'G',
  'G♯',
  'A',
  'A♯',
  'B',
]

export function pitchClassName(pitch: number): string {
  return PITCH_CLASS_NAMES[((pitch % 12) + 12) % 12]!
}

const FONT_NAME = 'midee-note-label'
const FONT_SIZE = 10

// The label sits in a small pill at the bar's leading (bottom) edge: a darker
// shade of the bar's own colour under white text. Bars are drawn at velocity
// alpha over a near-black background, so the effective bar colour varies a
// lot — the pill gives the text one consistent, high-contrast surface on
// every theme instead of guessing an ink colour per bar.
// Sized as a badge, not a cap: a translucent capsule inset from the bar so the
// bar colour still frames it, tinting rather than covering.
const PILL_HEIGHT = 14
const PILL_INSET_X = 3
const PILL_INSET_BOTTOM = 4
const PILL_RADIUS = PILL_HEIGHT / 2
const PILL_SHADE = 0.22 // bar colour × this = pill colour
const PILL_ALPHA = 0.6
const INK = 0xffffff
const INK_ALPHA = 0.94
// Bars at least this tall get the pill inset at the bottom edge; shorter ones
// get it centred (overhanging top and bottom on very short notes, which reads
// as "a badge on a dot"). Below MIN_BAR_HEIGHT the bar is a sliver — skip.
const INSET_BAR_HEIGHT = PILL_HEIGHT + PILL_INSET_BOTTOM * 2
const MIN_BAR_HEIGHT = 8
const TEXT_PAD_X = 3
// Narrow bars (black keys carrying a two-glyph "F♯") let the pill grow past
// the bar edges by a hair. The pill is a dark translucent shape over a
// near-black background, so the overhang is all but invisible — the badge
// only reads where it overlaps the bar.
const MAX_PILL_OVERHANG_X = 2
const MIN_TEXT_PAD_X = 1

// Pill width for a bar, or 0 when the label can't fit. Prefers the comfortable
// inset; on narrow bars widens the pill as far as the overhang allows.
// Pure so it can be unit-tested.
export function pillWidth(textWidth: number, barWidth: number, barHeight: number): number {
  if (barHeight < MIN_BAR_HEIGHT) return 0
  const maxPill = barWidth + MAX_PILL_OVERHANG_X * 2
  if (maxPill < textWidth + MIN_TEXT_PAD_X * 2) return 0
  const preferred = barWidth - PILL_INSET_X * 2
  const needed = textWidth + TEXT_PAD_X * 2
  return Math.max(preferred, Math.min(needed, maxPill))
}

// Top edge of the pill for a bar whose leading (bottom) edge is `bottomY`.
export function pillTop(bottomY: number, barHeight: number): number {
  if (barHeight >= INSET_BAR_HEIGHT) return bottomY - PILL_INSET_BOTTOM - PILL_HEIGHT
  return bottomY - barHeight / 2 - PILL_HEIGHT / 2
}

// Darker shade of the bar colour for the pill — keeps the label "of" its bar.
export function pillColor(color: number): number {
  const r = Math.round(((color >> 16) & 0xff) * PILL_SHADE)
  const g = Math.round(((color >> 8) & 0xff) * PILL_SHADE)
  const b = Math.round((color & 0xff) * PILL_SHADE)
  return (r << 16) | (g << 8) | b
}

export class NoteLabelLayer {
  readonly container: Container
  // One Graphics for every pill (batched), under the pooled text objects.
  private pills = new Graphics()
  private pool: BitmapText[] = []
  private used = 0
  private enabled = false
  private targetAlpha = 0
  // Measured once after the font is installed — indexed by pitch class.
  private textWidths: number[] | null = null
  private style: TextStyle | null = null
  private installing = false

  constructor() {
    this.container = new Container()
    this.container.label = 'note-labels'
    this.container.visible = false
    this.container.alpha = 0
    this.container.addChild(this.pills)
  }

  // Idempotent. Waits for the web font so we never bake a fallback face.
  private ensureFont(): void {
    if (this.style || this.installing) return
    this.installing = true
    const install = () => {
      BitmapFont.install({
        name: FONT_NAME,
        style: {
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: FONT_SIZE,
          fontWeight: '600',
          fill: 0xffffff,
        },
        chars: [...new Set(PITCH_CLASS_NAMES.join(''))].join(''),
        resolution: 2,
        padding: 2,
      })
      // Dynamic bitmap fonts apply the *text* style's fill as a tint — it must
      // be set here, not only on the installed font.
      const style = new TextStyle({ fontFamily: FONT_NAME, fontSize: FONT_SIZE, fill: INK })
      // measureText reports glyph-atlas units; `scale` maps them to FONT_SIZE px.
      this.textWidths = PITCH_CLASS_NAMES.map((s) => {
        const m = BitmapFontManager.measureText(s, style)
        return m.width * m.scale
      })
      this.style = style
    }
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined
    if (fonts?.ready) void fonts.ready.then(install, install)
    else install()
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.targetAlpha = on ? 1 : 0
    if (on) this.ensureFont()
  }

  get isActive(): boolean {
    // Keep drawing during the fade-out so labels dissolve instead of popping.
    return this.style !== null && (this.enabled || this.container.alpha > 0)
  }

  // Start of frame: rewind the pool and step the fade.
  begin(): void {
    this.used = 0
    this.pills.clear()
    const a = this.container.alpha
    if (a !== this.targetAlpha) {
      const next = a + (this.targetAlpha - a) * 0.18
      this.container.alpha = Math.abs(next - this.targetAlpha) < 0.01 ? this.targetAlpha : next
    }
    this.container.visible = this.container.alpha > 0
  }

  // Place a label for a bar. `bottomY` is the bar's leading edge (nearest the
  // keyboard). Silently skips when the bar is too small.
  place(
    pitch: number,
    x: number,
    w: number,
    bottomY: number,
    h: number,
    color: number,
    alpha: number,
  ): void {
    const widths = this.textWidths
    if (!widths) return
    const pc = ((pitch % 12) + 12) % 12
    const pillW = pillWidth(widths[pc]!, w, h)
    if (pillW === 0) return

    let label = this.pool[this.used]
    if (!label) {
      label = new BitmapText({ text: '', style: this.style! })
      label.anchor.set(0.5, 0.5)
      label.roundPixels = true
      this.pool.push(label)
      this.container.addChild(label)
    }
    this.used++

    // Pill follows the bar's dimming (velocity / practice focus) so quiet or
    // out-of-focus tracks stay quiet; the text keeps most of its contrast on
    // top of it either way.
    const top = pillTop(bottomY, h)
    this.pills.roundRect(x + (w - pillW) / 2, top, pillW, PILL_HEIGHT, PILL_RADIUS)
    this.pills.fill({ color: pillColor(color), alpha: PILL_ALPHA * alpha })

    label.text = PITCH_CLASS_NAMES[pc]!
    label.alpha = INK_ALPHA * Math.max(alpha, 0.6)
    // +0.5: optical centre of caps sits a hair below the em box's centre.
    label.position.set(x + w / 2, top + PILL_HEIGHT / 2 + 0.5)
    label.visible = true
  }

  // End of frame: hide whatever the pool didn't hand out.
  end(): void {
    for (let i = this.used; i < this.pool.length; i++) {
      const l = this.pool[i]!
      if (!l.visible) break // trailing slots were already hidden last frame
      l.visible = false
    }
  }

  clear(): void {
    this.used = 0
    this.pills.clear()
    this.end()
  }
}
