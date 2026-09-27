import {
  type BLEND_MODES,
  Container,
  Graphics,
  NineSliceSprite,
  type Renderer,
  RenderTexture,
  Texture,
} from 'pixi.js'
import { GlowFilter } from 'pixi-filters'

// Baked note glow — a cheap stand-in for NoteRenderer's GlowFilter, and the
// default since 2026-09-28 (`setGlowMode('filter')` keeps the filter for A/B).
// Measured on export: weak-GPU proxy (headless SwiftShader 720p) 25.6 → 51.6
// fps, the same as no glow at all; Safari M4 1080p +19 %; Chrome M4 unchanged
// (encoder-bound) with 13–29 % less GPU per frame. Visual A/B vs the filter:
// 56–76 dB whole-frame PSNR, differences only at sounding-note edges
// (docs/EXPORT_PERF_MEASUREMENTS_2026-09-27.md; bench suite `glowshots`).
//
// Why: GlowFilter is a brute-force ring sampler. Every output pixel reads the
// texture ≈ 2π·quality·distance² times (29 angles × 15 steps = 435 for the
// default 'sunset' theme) over the bounds of all sounding notes, every frame.
// MP4 export on weak GPUs is render-bound and the glow is about half of it:
// headless SwiftShader at 720p exports at 31 fps with glow vs 46 without (GPU
// 32 → 17 ms/frame); on an M4 the glow costs 7–21 %.
//
// How: a lone note's halo depends only on its rect, so the real GlowFilter
// runs ONCE over a white note-shaped rect (alpha 0.9 — what NoteRenderer feeds
// the filter) into a texture, and each sounding note draws that texture as a
// tinted NineSliceSprite: a quad instead of ~435 reads per pixel.
//  · One bake per note width, never stretched sideways: a narrow note's halo
//    is genuinely fainter (less rect within the filter's reach). A key layout
//    has exactly two note widths (white / black keys).
//  · Heights 3-slice: a halo row whose filter reach can't see the rounded
//    ends is the same for any note length, so the tall bake's middle band
//    stretches losslessly (`haloLayout`). Notes shorter than that — every
//    sounding note ends as a sliver at the strike line — use an exact bake of
//    their whole-px height, made on first use and cached.
//  · Resolution 1, like the filter itself (Pixi's Filter default): the sprite
//    shows the same upsampled pixels the filter produces at 2K/4K today, the
//    halo has no hard edge to lose, and nothing re-bakes when the export
//    changes the renderer resolution.
//
// The bake includes the rect's own fill, so a halo is ~opaque over its note;
// NoteRenderer still draws its 0.9-alpha overlay rects on top → 0.9·note +
// 0.1·glow inside the note, as the filter composes it. Those rects are no
// longer rasterized inside the filter (res 1, no MSAA), so sounding notes are
// slightly crisper at resolution > 1 than in 'filter' mode.
//
// Known differences from the filter:
//  · Overlapping halos (chords, adjacent keys). The filter sums coverage over
//    the union silhouette, then clamps; sprites blend 'normal'. Identical
//    wherever either halo is saturated (right next to the notes); up to ~25 %
//    dimmer where two faint halos overlap (e.g. above a cluster). 'add' would
//    match faint overlaps but over-brightens saturated ones and adds light
//    onto nearby unlit notes where the filter covers them — see HALO_BLEND.
//  · Colour: see GlowTint.

export type GlowMode = 'filter' | 'baked'
// 'average' = filter parity: GlowFilter has one colour, the mean of the
// sounding notes' colours. 'note' tints each halo with its own note's colour
// (differs only when notes from differently coloured tracks sound together).
export type GlowTint = 'average' | 'note'

const settings: { mode: GlowMode; tint: GlowTint } = { mode: 'baked', tint: 'average' }

// Module-level so it flips without UI: the bench's `&glow=baked` URL param
// (bench/runner.ts), or devtools under `npm run dev`:
//   (await import('/src/renderer/bakedGlow.ts')).setGlowMode('baked')
// NoteRenderer picks it up on its next draw.
export function setGlowMode(mode: GlowMode, tint: GlowTint = settings.tint): void {
  settings.mode = mode
  settings.tint = tint
}

export function glowSettings(): Readonly<{ mode: GlowMode; tint: GlowTint }> {
  return settings
}

// Shared with NoteRenderer's filter path so both glow the same input.
export const GLOW_QUALITY = 0.3
export const ACTIVE_NOTE_ALPHA = 0.9

// Exact for a lone note (the filter's output composites 'normal' too).
const HALO_BLEND: BLEND_MODES = 'normal'
// Px past the filter's `distance` that still influence a halo row: its
// bilinear sample footprint, plus the sprite's own when it samples the band.
const REACH_SLACK = 2
// Rows of the tall bake the sprite stretches (identical rows).
const MIDDLE_BAND = 2
// A key layout has two note widths (white / black). More means the layout
// changed (resize, export, pitch range) and the unused ones are stale.
const MAX_WIDTHS = 2

// Bake geometry for one note width, in logical px.
export interface HaloLayout {
  pad: number // halo reach past the note on every side (= glow distance)
  texWidth: number // bake / sprite width: the note plus a pad each side
  border: number // tall bake's top and bottom slice
  minSliceHeight: number // shortest note the tall bake stretches to exactly
  tallHeight: number // rect height of the tall bake
}

export function haloLayout(distance: number, noteRadius: number, noteWidth: number): HaloLayout {
  const pad = distance
  // Pixi clamps a roundRect's radius to half its shorter side.
  const radius = Math.min(noteRadius, noteWidth / 2)
  // From the texture top: the pad, the rounded end, then one filter reach —
  // rows below that never sample the end, so they repeat down the note.
  const border = Math.ceil(pad + radius + distance + REACH_SLACK)
  const minSliceHeight = 2 * (border - pad) // sprite height h + 2·pad ≥ 2·border
  return {
    pad,
    texWidth: Math.ceil(noteWidth + 2 * pad),
    border,
    minSliceHeight,
    tallHeight: minSliceHeight + MIDDLE_BAND,
  }
}

// Rect height of the exact short bake a note `h` px tall uses, or null when
// the tall bake 3-slices to it.
export function shortBakeHeight(layout: HaloLayout, h: number): number | null {
  return h >= layout.minSliceHeight ? null : Math.max(1, Math.round(h))
}

interface WidthBakes {
  layout: HaloLayout
  tall: Texture | null
  short: (Texture | undefined)[] // exact bakes, indexed by rect height
  frame: number // last frame that drew this width
}

function destroyBakes(bakes: WidthBakes): void {
  bakes.tall?.destroy(true)
  for (const texture of bakes.short) texture?.destroy(true)
}

// Per-frame halo sprites for NoteRenderer: begin() → add() per sounding note
// → end(). Sprites are pooled; bakes are cached per width until the theme's
// glow params change, the layout moves on, release() or destroy().
export class BakedGlow {
  readonly container = new Container()
  private sprites: NineSliceSprite[] = []
  private used = 0
  private frame = 0
  private widths = new Map<number, WidthBakes>()
  private filter: GlowFilter | null = null
  private distance = 0
  private strength = 0
  private radius = 0

  constructor(private readonly renderer: Renderer) {
    this.container.label = 'note-glow-baked'
  }

  begin(distance: number, strength: number, radius: number): void {
    if (distance !== this.distance || strength !== this.strength || radius !== this.radius) {
      this.release()
      this.distance = distance
      this.strength = strength
      this.radius = radius
    }
    this.frame++
    this.used = 0
  }

  // x/y/w/h exactly as NoteRenderer draws the note's rect.
  add(x: number, y: number, w: number, h: number, color: number): void {
    const bakes = this.bakesFor(w)
    const { layout } = bakes
    const shortH = shortBakeHeight(layout, h)
    let texture: Texture
    if (shortH === null) {
      bakes.tall ??= this.bake(w, layout.tallHeight, layout)
      texture = bakes.tall
    } else {
      texture = bakes.short[shortH] ?? this.bake(w, shortH, layout)
      bakes.short[shortH] = texture
    }
    // Short bakes are stretched ≤ 0.5 px through the rect rows only.
    const slice = shortH === null ? layout.border : layout.pad

    const sprite = this.sprites[this.used] ?? this.newSprite()
    this.used++
    sprite.texture = texture
    if (sprite.topHeight !== slice) {
      sprite.topHeight = slice
      sprite.bottomHeight = slice
    }
    sprite.setSize(layout.texWidth, h + 2 * layout.pad)
    sprite.position.set(x - layout.pad, y - layout.pad)
    sprite.tint = color
    sprite.visible = true
  }

  // `tint` recolours every halo (GlowTint 'average'); null keeps each note's.
  end(tint: number | null): void {
    const { sprites, used } = this
    if (tint !== null) for (let i = 0; i < used; i++) sprites[i]!.tint = tint
    for (let i = used; i < sprites.length; i++) sprites[i]!.visible = false
    if (this.widths.size <= MAX_WIDTHS) return
    for (const [w, bakes] of this.widths) {
      if (bakes.frame === this.frame) continue
      destroyBakes(bakes)
      this.widths.delete(w)
    }
    // Hidden sprites may still point at what was just destroyed.
    for (let i = used; i < sprites.length; i++) sprites[i]!.texture = Texture.EMPTY
  }

  // Frees every bake: theme change, switching back to 'filter', destroy().
  release(): void {
    for (const sprite of this.sprites) {
      sprite.texture = Texture.EMPTY
      sprite.visible = false
    }
    this.used = 0
    for (const bakes of this.widths.values()) destroyBakes(bakes)
    this.widths.clear()
    this.filter?.destroy()
    this.filter = null
  }

  destroy(): void {
    this.release()
    this.container.destroy({ children: true })
    this.sprites = []
  }

  private bakesFor(w: number): WidthBakes {
    let bakes = this.widths.get(w)
    if (!bakes) {
      bakes = { layout: haloLayout(this.distance, this.radius, w), tall: null, short: [], frame: 0 }
      this.widths.set(w, bakes)
    }
    bakes.frame = this.frame
    return bakes
  }

  // The real GlowFilter, once, over a white note-shaped rect.
  private bake(w: number, rectH: number, layout: HaloLayout): Texture {
    this.filter ??= new GlowFilter({
      distance: this.distance,
      outerStrength: this.strength,
      innerStrength: 0,
      color: 0xffffff,
      quality: GLOW_QUALITY,
    })
    const root = new Container()
    const shape = root.addChild(new Graphics())
    shape
      .roundRect(layout.pad, layout.pad, w, rectH, this.radius)
      .fill({ color: 0xffffff, alpha: ACTIVE_NOTE_ALPHA })
    shape.filters = [this.filter]
    const texture = RenderTexture.create({
      width: layout.texWidth,
      height: rectH + 2 * layout.pad,
    })
    this.renderer.render({ container: root, target: texture })
    root.destroy({ children: true })
    return texture
  }

  private newSprite(): NineSliceSprite {
    const sprite = new NineSliceSprite({
      texture: Texture.EMPTY,
      leftWidth: 0,
      rightWidth: 0,
      topHeight: 0,
      bottomHeight: 0,
    })
    sprite.blendMode = HALO_BLEND
    this.container.addChild(sprite)
    this.sprites.push(sprite)
    return sprite
  }
}
