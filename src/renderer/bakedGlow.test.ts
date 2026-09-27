import type { Renderer } from 'pixi.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BakedGlow, glowSettings, haloLayout, setGlowMode, shortBakeHeight } from './bakedGlow'
import { THEMES } from './theme'

// Layout maths, bake caching, pooling and tint without a GPU: pixi is mocked
// down to the properties BakedGlow sets. What the bakes look like is the
// real GlowFilter's business (visual A/B against glow mode 'filter').
vi.mock('pixi.js', () => {
  class MockContainer {
    children: unknown[] = []
    visible = true
    label = ''
    filters: unknown[] | null = null
    destroyed = false
    addChild<T>(child: T): T {
      this.children.push(child)
      return child
    }
    destroy() {
      this.destroyed = true
    }
  }
  class MockGraphics extends MockContainer {
    roundRect = vi.fn(() => this)
    fill = vi.fn(() => this)
  }
  class MockNineSliceSprite {
    texture: unknown
    topHeight: number
    bottomHeight: number
    leftWidth: number
    rightWidth: number
    width = 0
    height = 0
    position = {
      x: 0,
      y: 0,
      set(x: number, y: number) {
        this.x = x
        this.y = y
      },
    }
    tint = 0xffffff
    visible = true
    blendMode = 'normal'
    constructor(o: {
      texture: unknown
      topHeight: number
      bottomHeight: number
      leftWidth: number
      rightWidth: number
    }) {
      this.texture = o.texture
      this.topHeight = o.topHeight
      this.bottomHeight = o.bottomHeight
      this.leftWidth = o.leftWidth
      this.rightWidth = o.rightWidth
    }
    setSize(w: number, h: number) {
      this.width = w
      this.height = h
    }
  }
  return {
    Container: MockContainer,
    Graphics: MockGraphics,
    NineSliceSprite: MockNineSliceSprite,
    RenderTexture: {
      create: vi.fn((o: { width: number; height: number }) => ({ ...o, destroy: vi.fn() })),
    },
    Texture: { EMPTY: { label: 'EMPTY' } },
  }
})
vi.mock('pixi-filters', () => ({
  GlowFilter: class {
    destroy = vi.fn()
    constructor(public options: Record<string, number>) {}
  },
}))

interface MockSprite {
  texture: { width: number; height: number; destroy: () => void; label?: string }
  topHeight: number
  bottomHeight: number
  width: number
  height: number
  position: { x: number; y: number }
  tint: number
  visible: boolean
}
interface MockRender {
  container: { children: Array<{ roundRect: ReturnType<typeof vi.fn>; filters: unknown[] }> }
  target: { width: number; height: number }
}

const SUNSET = { distance: 15, strength: 3, radius: 8 }
const WHITE = 35.9 // a white-key note at the 1920-px export stage
const BLACK = 20.4

function setup() {
  const renderer = { render: vi.fn() }
  const glow = new BakedGlow(renderer as unknown as Renderer)
  const sprites = () => glow.container.children as unknown as MockSprite[]
  const visible = () => sprites().filter((s) => s.visible)
  const renders = () => renderer.render.mock.calls.map(([o]) => o as MockRender)
  return { glow, renderer, sprites, visible, renders }
}

type Note = [x: number, y: number, w: number, h: number, color: number]

function frame(glow: BakedGlow, notes: Note[], tint: number | null = null) {
  glow.begin(SUNSET.distance, SUNSET.strength, SUNSET.radius)
  for (const [x, y, w, h, color] of notes) glow.add(x, y, w, h, color)
  glow.end(tint)
}

afterEach(() => setGlowMode('baked', 'average'))

describe('glow mode switch', () => {
  it('defaults to the baked glow with filter-parity tint', () => {
    expect(glowSettings()).toEqual({ mode: 'baked', tint: 'average' })
  })

  it('keeps the tint unless one is given', () => {
    setGlowMode('baked', 'note')
    setGlowMode('filter')
    expect(glowSettings()).toEqual({ mode: 'filter', tint: 'note' })
  })
})

describe('haloLayout', () => {
  it('sizes the sunset white-key bake', () => {
    const l = haloLayout(SUNSET.distance, SUNSET.radius, WHITE)
    // pad + radius + one filter reach + 2 px slack = 15 + 8 + 15 + 2
    expect(l).toEqual({ pad: 15, texWidth: 66, border: 40, minSliceHeight: 50, tallHeight: 52 })
  })

  it('uses the radius Pixi actually draws on narrow notes', () => {
    // A phone-width note: roundRect clamps the radius to w/2 = 3.25.
    expect(haloLayout(15, 8, 6.5).border).toBe(Math.ceil(15 + 3.25 + 15 + 2))
  })

  for (const theme of THEMES.filter((t) => !t.noteMaterial)) {
    for (const w of [2, 6.5, BLACK, WHITE, 120]) {
      it(`${theme.name} w=${w}: the stretched band never sees a rounded end`, () => {
        const d = theme.noteGlowDistance
        const r = Math.min(theme.noteRadius, w / 2)
        const l = haloLayout(d, theme.noteRadius, w)
        // Texture rows [border, border + band) are ≥ radius + reach from the
        // rect's ends; the tall bake is exactly two borders plus the band.
        expect(l.border - l.pad).toBeGreaterThanOrEqual(r + d + 1)
        expect(l.tallHeight + 2 * l.pad).toBe(2 * l.border + 2)
        expect(l.texWidth).toBeGreaterThanOrEqual(w + 2 * d)
        // The shortest sliced sprite fits both borders without Pixi scaling them.
        expect(l.minSliceHeight + 2 * l.pad).toBe(2 * l.border)
      })
    }
  }
})

describe('shortBakeHeight', () => {
  const l = haloLayout(SUNSET.distance, SUNSET.radius, WHITE)
  it('slices notes at least minSliceHeight tall', () => {
    expect(shortBakeHeight(l, l.minSliceHeight)).toBeNull()
    expect(shortBakeHeight(l, 400)).toBeNull()
  })
  it('bakes shorter notes exactly, per whole px', () => {
    expect(shortBakeHeight(l, 3)).toBe(3)
    expect(shortBakeHeight(l, 12.4)).toBe(12)
    expect(shortBakeHeight(l, 11.6)).toBe(12)
    expect(shortBakeHeight(l, l.minSliceHeight - 0.2)).toBe(l.minSliceHeight)
    expect(shortBakeHeight(l, 0.2)).toBe(1)
  })
})

describe('BakedGlow', () => {
  it('bakes with the real GlowFilter over a white 0.9 note rect', () => {
    const { glow, renders } = setup()
    frame(glow, [[100, 200, WHITE, 300, 0xf97316]])
    const [bake] = renders()
    const shape = bake!.container.children[0]!
    expect(shape.roundRect).toHaveBeenCalledWith(15, 15, WHITE, 52, 8)
    expect((shape as unknown as { fill: ReturnType<typeof vi.fn> }).fill).toHaveBeenCalledWith({
      color: 0xffffff,
      alpha: 0.9,
    })
    expect((shape.filters[0] as { options: unknown }).options).toEqual({
      distance: 15,
      outerStrength: 3,
      innerStrength: 0,
      color: 0xffffff,
      quality: 0.3,
    })
    expect(bake!.target).toMatchObject({ width: 66, height: 82 })
  })

  it('places a tall note as a 3-sliced sprite padded by the glow distance', () => {
    const { glow, visible } = setup()
    frame(glow, [[100, 200, WHITE, 300, 0xf97316]])
    const [s] = visible()
    expect(s).toMatchObject({ topHeight: 40, bottomHeight: 40, width: 66, height: 330 })
    expect(s!.position).toMatchObject({ x: 85, y: 185 })
    expect(s!.texture).toMatchObject({ width: 66, height: 82 })
  })

  it('gives a short note its own exact bake, stretched only through the rect', () => {
    const { glow, visible } = setup()
    frame(glow, [[100, 700, WHITE, 12.4, 0xf97316]])
    const [s] = visible()
    // Rect rounded to 12 px; the pad rows (15) map 1:1, no Pixi border scaling.
    expect(s!.texture).toMatchObject({ width: 66, height: 42 })
    expect(s).toMatchObject({ topHeight: 15, bottomHeight: 15, height: 42.4 })
  })

  it('bakes once per width and height bucket, then reuses', () => {
    const { glow, renderer } = setup()
    const chord: Note[] = [
      [0, 0, WHITE, 300, 1],
      [40, 0, WHITE, 500, 2], // same tall bake
      [80, 0, BLACK, 300, 3], // new width
      [120, 0, WHITE, 12.4, 4], // short bucket 12
      [160, 0, WHITE, 11.6, 5], // same bucket
    ]
    frame(glow, chord)
    expect(renderer.render).toHaveBeenCalledTimes(3)
    frame(glow, chord)
    frame(glow, chord)
    expect(renderer.render).toHaveBeenCalledTimes(3)
  })

  it('pools sprites and hides the ones a frame does not use', () => {
    const { glow, sprites, visible } = setup()
    frame(glow, [
      [0, 0, WHITE, 300, 1],
      [40, 0, WHITE, 300, 2],
      [80, 0, WHITE, 300, 3],
    ])
    expect(visible()).toHaveLength(3)
    frame(glow, [[0, 0, WHITE, 300, 1]])
    expect(sprites()).toHaveLength(3)
    expect(visible()).toHaveLength(1)
    frame(glow, [
      [0, 0, WHITE, 300, 1],
      [0, 0, WHITE, 300, 1],
      [0, 0, WHITE, 300, 1],
      [0, 0, WHITE, 300, 1],
    ])
    expect(sprites()).toHaveLength(4)
    expect(visible()).toHaveLength(4)
  })

  it("keeps each note's colour, or recolours all with the filter's average", () => {
    const { glow, visible } = setup()
    const notes: Note[] = [
      [0, 0, WHITE, 300, 0xff0000],
      [40, 0, WHITE, 300, 0x0000ff],
    ]
    frame(glow, notes)
    expect(visible().map((s) => s.tint)).toEqual([0xff0000, 0x0000ff])
    frame(glow, notes, 0x800080)
    expect(visible().map((s) => s.tint)).toEqual([0x800080, 0x800080])
  })

  it('re-bakes everything when the theme glow params change', () => {
    const { glow, renderer, sprites, renders } = setup()
    frame(glow, [[0, 0, WHITE, 300, 1]])
    const old = renders()[0]!
    const oldTexture = sprites()[0]!.texture
    const oldFilter = old.container.children[0]!.filters[0] as { destroy: () => void }
    glow.begin(20, 4.5, 8) // neon
    expect(oldTexture.destroy).toHaveBeenCalledWith(true)
    expect(oldFilter.destroy).toHaveBeenCalled()
    expect(sprites()[0]).toMatchObject({ visible: false, texture: { label: 'EMPTY' } })
    glow.add(0, 0, WHITE, 300, 1)
    glow.end(null)
    expect(renderer.render).toHaveBeenCalledTimes(2)
    const neon = renders()[1]!
    expect(neon.container.children[0]!.filters[0]).toMatchObject({ options: { distance: 20 } })
    expect(neon.target).toMatchObject({ width: Math.ceil(WHITE + 40) })
  })

  it('drops the previous key layout once a new one is drawing', () => {
    const { glow, sprites } = setup()
    frame(glow, [
      [0, 0, WHITE, 300, 1],
      [40, 0, BLACK, 300, 2],
    ])
    const [white, black] = sprites().map((s) => s.texture)
    // Resize: new widths. Two old + one new > two → the unused old go.
    frame(glow, [[0, 0, 30, 300, 1]])
    expect(white!.destroy).toHaveBeenCalledWith(true)
    expect(black!.destroy).toHaveBeenCalledWith(true)
    expect(sprites()[1]!.texture).toMatchObject({ label: 'EMPTY' })
    expect(sprites()[0]!.texture.destroy).not.toHaveBeenCalled()
  })

  it('keeps both widths of one layout across frames that only use one', () => {
    const { glow, sprites } = setup()
    frame(glow, [
      [0, 0, WHITE, 300, 1],
      [40, 0, BLACK, 300, 2],
    ])
    const black = sprites()[1]!.texture
    frame(glow, [[0, 0, WHITE, 300, 1]])
    expect(black.destroy).not.toHaveBeenCalled()
  })

  it('frees its textures on release() and destroy()', () => {
    const { glow, sprites } = setup()
    frame(glow, [[0, 0, WHITE, 300, 1]])
    const texture = sprites()[0]!.texture
    glow.release()
    expect(texture.destroy).toHaveBeenCalledWith(true)
    expect(sprites()[0]!.visible).toBe(false)
    frame(glow, [[0, 0, WHITE, 12, 1]])
    const short = sprites()[0]!.texture
    glow.destroy()
    expect(short.destroy).toHaveBeenCalledWith(true)
    expect(glow.container).toMatchObject({ destroyed: true })
  })
})
