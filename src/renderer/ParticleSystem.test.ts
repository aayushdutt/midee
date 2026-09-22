import { type Sprite, Texture } from 'pixi.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MATERIAL_CHOREOGRAPHY } from './materialParticles'
import { type ParticleStyle, ParticleSystem } from './ParticleSystem'
import { ALL_PARTICLE_STYLES } from './particleStyles'

// Exercise the actual particle lifecycle and motion without a GPU. Drawing
// and texture upload are covered by the browser theme/playback tests.
vi.mock('pixi.js', () => {
  class Point {
    x = 0
    y = 0
    set(x: number, y = x) {
      this.x = x
      this.y = y
    }
  }
  class MockSprite {
    anchor = new Point()
    position = new Point()
    scale = new Point()
    visible = false
    alpha = 1
    tint = 0xffffff
    rotation = 0
    constructor(public texture: unknown) {}
  }
  return {
    Container: class {
      children: MockSprite[] = []
      addChild(sprite: MockSprite) {
        this.children.push(sprite)
      }
      destroy() {
        this.children = []
      }
    },
    Sprite: MockSprite,
    Texture: { from: vi.fn(() => ({ destroy: vi.fn() })) },
  }
})

beforeEach(() => {
  vi.mocked(Texture.from).mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    stroke() {},
    bezierCurveTo() {},
    arc() {},
  } as unknown as ReturnType<HTMLCanvasElement['getContext']>)
})
afterEach(() => vi.restoreAllMocks())

function snapshot(system: ParticleSystem) {
  return (system.container.children as Sprite[])
    .filter((sprite) => sprite.visible)
    .map((sprite) => ({
      x: sprite.position.x,
      y: sprite.position.y,
      alpha: sprite.alpha,
      rotation: sprite.rotation,
      scaleX: sprite.scale.x,
      scaleY: sprite.scale.y,
      tint: sprite.tint,
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y)
}

function glass() {
  const system = new ParticleSystem()
  system.setStyle('glass')
  return system
}

describe('glass glints', () => {
  it('samples the same motion at 30, 60 and 120 fps', () => {
    const samples = [30, 60, 120].map((fps) => {
      const system = glass()
      system.burst(200, 400, 0x91cddd)
      for (let i = 0; i < fps / 2; i++) system.update(1 / fps)
      const result = snapshot(system)
      system.destroy()
      return result
    })
    expect(samples[0]).toHaveLength(26)
    for (const other of samples.slice(1)) {
      for (let i = 0; i < other.length; i++) {
        for (const key of ['x', 'y', 'alpha', 'rotation', 'scaleX', 'scaleY', 'tint'] as const) {
          expect(other[i]![key]).toBeCloseTo(samples[0]![i]![key], 10)
        }
      }
    }
  })

  it('does not advance during zero-delta preview / static repaints', () => {
    const system = glass()
    system.burst(200, 400, 0x91cddd)
    system.update(0.2)
    const before = snapshot(system)
    for (let i = 0; i < 10; i++) system.update(0)
    expect(snapshot(system)).toEqual(before)
    system.destroy()
  })

  it('restarts the same glint sequence for a fresh export', () => {
    const system = glass()
    const take = () => {
      system.burst(200, 400, 0x91cddd)
      system.update(0.2)
      return snapshot(system)
    }
    const first = take()
    system.clear()
    expect(take()).toEqual(first)
    system.destroy()
  })

  it('bounds dense-chord debris and returns expired particles to the pool', () => {
    const system = glass()
    for (let i = 0; i < 100; i++) system.burst(i * 10, 400, 0x91cddd)
    expect(snapshot(system)).toHaveLength(448)
    system.update(2)
    expect(system.hasActive).toBe(false)
    expect(snapshot(system)).toHaveLength(0)
    system.burst(200, 400, 0x91cddd)
    expect(snapshot(system)).toHaveLength(26)
    system.destroy()
  })

  it('clears glass sprites when changing style and respects Off', () => {
    const system = glass()
    system.burst(200, 400, 0x91cddd)
    system.setStyle('sparks')
    expect(system.hasActive).toBe(false)
    system.burst(200, 400, 0x91cddd)
    expect(snapshot(system)).toHaveLength(14)
    system.setStyle('none')
    system.burst(200, 400, 0x91cddd)
    expect(snapshot(system)).toHaveLength(0)
    system.destroy()
  })
})

const materialCases = [
  { style: 'silk', onset: 33, sustain: 4, cap: 448 },
  { style: 'gold', onset: 24, sustain: 3, cap: 480 },
  { style: 'pearl', onset: 33, sustain: 4, cap: 448 },
  { style: 'liquid', onset: 37, sustain: 5, cap: 512 },
  { style: 'mist', onset: 29, sustain: 4, cap: 384 },
] as const

function material(style: ParticleStyle) {
  const system = new ParticleSystem()
  system.setStyle(style)
  return system
}

describe.each(materialCases)('$style material particles', ({ style, onset, sustain, cap }) => {
  it('samples the same choreography at 30, 60 and 120 fps', () => {
    const samples = [30, 60, 120].map((fps) => {
      const system = material(style)
      system.burst(200, 400, 0x91cddd)
      for (let frame = 0; frame < fps / 2; frame++) system.update(1 / fps)
      const result = snapshot(system)
      system.destroy()
      return result
    })
    expect(samples[0]).toHaveLength(onset)
    for (const other of samples.slice(1)) {
      expect(other).toHaveLength(onset)
      for (let i = 0; i < other.length; i++) {
        for (const key of ['x', 'y', 'alpha', 'rotation', 'scaleX', 'scaleY', 'tint'] as const) {
          expect(other[i]![key]).toBeCloseTo(samples[0]![i]![key], 10)
        }
      }
    }
  })

  it('has prompt first-frame light and reaches clearly beyond a key at midlife', () => {
    const system = material(style)
    system.burst(200, 400, 0x91cddd, 20)
    system.update(1 / 60)
    expect(Math.max(...snapshot(system).map((p) => p.alpha))).toBeGreaterThan(0.15)
    system.update(0.5 - 1 / 60)
    // The main forms rise several key widths, rather than hovering as tiny
    // nearly invisible debris at the strike line.
    expect(Math.min(...snapshot(system).map((p) => p.y))).toBeLessThan(360)
    system.destroy()
  })

  it('has no simulation changes on preview repaints and replays a seeded take', () => {
    const system = material(style)
    const take = () => {
      system.burst(200, 400, 0x91cddd)
      system.update(0.2)
      system.sustainBurst(200, 400, 0x91cddd)
      system.update(0.15)
      return snapshot(system)
    }
    const first = take()
    for (let i = 0; i < 10; i++) system.update(0)
    expect(snapshot(system)).toEqual(first)
    system.clear()
    expect(take()).toEqual(first)
    system.destroy()
  })

  it('keeps contact effects exclusive to onsets and recycles the bounded pool after dense chords', () => {
    const system = material(style)
    system.sustainBurst(200, 400, 0x91cddd)
    system.update(0.2)
    expect(snapshot(system)).toHaveLength(sustain)
    // Held notes shed fine material, without stacking broad impact lights.
    expect(MATERIAL_CHOREOGRAPHY[style].sustain).not.toContain('contact')
    for (let i = 0; i < 100; i++) system.burst(i * 10, 400, 0x91cddd)
    expect(snapshot(system)).toHaveLength(cap)
    system.update(3)
    expect(system.hasActive).toBe(false)
    expect(snapshot(system)).toHaveLength(0)
    system.burst(200, 400, 0x91cddd)
    expect(snapshot(system)).toHaveLength(onset)
    system.destroy()
    expect(system.hasActive).toBe(false)
  })

  it('switches cleanly to legacy particles and Off, including explicit count overrides', () => {
    const system = material(style)
    system.burst(200, 400, 0x91cddd)
    system.setStyle('sparks')
    expect(system.hasActive).toBe(false)
    system.burst(200, 400, 0x91cddd)
    expect(snapshot(system)).toHaveLength(14)
    system.setStyle('none')
    system.burst(200, 400, 0x91cddd, 20, 5)
    system.sustainBurst(200, 400, 0x91cddd)
    expect(snapshot(system)).toHaveLength(0)
    system.destroy()
  })
})

describe('material particle resources and composition', () => {
  it('appends new choices without changing saved legacy indices', () => {
    expect(ALL_PARTICLE_STYLES.map(({ id }) => id)).toEqual([
      'sparks',
      'embers',
      'bloom',
      'sparkle',
      'none',
      'glass',
      'silk',
      'gold',
      'pearl',
      'liquid',
      'mist',
    ])
  })

  it('builds only selected styles, reuses shared textures and disposes every cached source', () => {
    const system = new ParticleSystem()
    expect(Texture.from).toHaveBeenCalledTimes(1)
    system.setStyle('liquid')
    // Radial + contact, powder, chip. No hidden silk/foil/old-glass textures.
    expect(Texture.from).toHaveBeenCalledTimes(4)
    system.burst(200, 400, 0x91cddd)
    system.update(0.1)
    const firstContact = (system.container.children as Sprite[]).find(
      (sprite) => sprite.visible && sprite.position.y === 398,
    )!.texture
    system.setStyle('pearl')
    // Reuse contact; add only mineral and pollen.
    expect(Texture.from).toHaveBeenCalledTimes(6)
    system.burst(200, 400, 0x91cddd)
    system.update(0.1)
    const opalContact = (system.container.children as Sprite[]).find(
      (sprite) => sprite.visible && sprite.position.y === 398,
    )!.texture
    expect(opalContact).toBe(firstContact)
    for (const style of ['none', 'liquid', 'pearl', 'liquid'] as const) {
      system.setStyle(style)
      system.burst(200, 400, 0x91cddd)
    }
    expect(Texture.from).toHaveBeenCalledTimes(6)
    // Hidden families remain usable without preallocating them for shipping presets.
    system.setStyle('silk')
    expect(Texture.from).toHaveBeenCalledTimes(7)
    system.setStyle('gold')
    expect(Texture.from).toHaveBeenCalledTimes(10)
    system.setStyle('glass')
    expect(Texture.from).toHaveBeenCalledTimes(15)
    system.setStyle('none')
    const textures = vi.mocked(Texture.from).mock.results.map(({ value }) => value as Texture)
    system.destroy()
    for (const texture of textures) {
      expect(texture.destroy).toHaveBeenCalledExactlyOnceWith(true)
    }
  })

  it('never creates textures in sustained frame updates or repeated bursts', () => {
    const system = material('liquid')
    expect(Texture.from).toHaveBeenCalledTimes(4)
    for (let frame = 0; frame < 240; frame++) {
      if (frame % 20 === 0) system.burst(200, 400, 0x91cddd)
      if (frame % 7 === 0) system.sustainBurst(200, 400, 0x91cddd)
      system.update(1 / 60)
    }
    system.clear()
    system.burst(200, 400, 0x91cddd)
    expect(Texture.from).toHaveBeenCalledTimes(4)
    system.destroy()
  })

  it('uses fine material shapes instead of beads, halos, or broad ribbons', () => {
    const allowed = {
      silk: ['contact', 'fiber', 'pollen'],
      pearl: ['contact', 'mineral', 'pollen'],
      liquid: ['contact', 'powder', 'chip'],
    } as const
    for (const style of ['silk', 'pearl', 'liquid'] as const) {
      const recipe = MATERIAL_CHOREOGRAPHY[style]
      expect(recipe.onset.length).toBeGreaterThanOrEqual(30)
      expect(recipe.onset.filter((kind) => kind === 'contact')).toHaveLength(1)
      for (const kind of [...recipe.onset, ...recipe.sustain]) {
        expect(allowed[style]).toContain(kind)
      }
    }
    const glass = MATERIAL_CHOREOGRAPHY.liquid.onset
    expect(glass.filter((kind) => kind === 'powder').length / glass.length).toBeGreaterThan(0.7)
  })

  it('keeps the liquid powder and chips fine while they disperse', () => {
    const system = material('liquid')
    system.burst(200, 400, 0x91cddd, 20)
    for (const dt of [0.18, 0.32]) {
      system.update(dt)
      const airborne = snapshot(system).filter((p) => p.y < 395)
      expect(airborne.length).toBeGreaterThan(20)
      for (const grain of airborne) {
        // Bound the whole sprite quad, including transparent margins. Tiny
        // optical grains must not swell into the former bubbles or splashes.
        expect(Math.max(grain.scaleX, grain.scaleY) * 64).toBeLessThan(10)
      }
    }
    system.destroy()
  })

  it('keeps mist plumes transparent, windblown and warm even with a purple note', () => {
    const system = material('mist')
    system.burst(200, 400, 0x9933ee, 20)
    system.update(0.2)
    const plumes = (system.container.children as Sprite[]).filter(
      (sprite) => sprite.visible && Math.abs(sprite.scale.x) * 64 > 20 && sprite.position.y < 395,
    )
    expect(plumes).toHaveLength(4)
    const grains = (system.container.children as Sprite[]).filter(
      (sprite) => sprite.visible && Math.abs(sprite.scale.x) * 64 < 10,
    )
    const grainPositions = grains.map((sprite) => sprite.position.x)
    const positions = plumes.map((sprite) => ({ x: sprite.position.x, y: sprite.position.y }))
    system.update(0.4)
    for (const [i, sprite] of grains.entries()) {
      expect(sprite.position.x).toBeGreaterThan(grainPositions[i]!)
    }
    for (const [i, sprite] of plumes.entries()) {
      expect(sprite.position.x).toBeGreaterThan(positions[i]!.x)
      expect(sprite.position.y).toBeLessThan(positions[i]!.y)
      expect(sprite.alpha).toBeLessThan(0.32)
      expect((sprite.tint >> 16) & 255).toBeGreaterThan((sprite.tint >> 8) & 255)
      expect((sprite.tint >> 8) & 255).toBeGreaterThan(sprite.tint & 255)
    }
    system.destroy()
  })

  it('lazily shares mist contact and dust textures with glass dust', () => {
    const system = material('liquid')
    expect(Texture.from).toHaveBeenCalledTimes(4)
    system.setStyle('mist')
    expect(Texture.from).toHaveBeenCalledTimes(5)
    system.setStyle('liquid')
    system.setStyle('mist')
    expect(Texture.from).toHaveBeenCalledTimes(5)
    const textures = vi.mocked(Texture.from).mock.results.map(({ value }) => value as Texture)
    system.destroy()
    for (const texture of textures) expect(texture.destroy).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('keeps lacquer particles warm gold even when the struck note is red', () => {
    const system = material('gold')
    system.burst(200, 400, 0x9d4256)
    for (const { tint } of snapshot(system)) {
      expect((tint >> 16) & 255).toBeGreaterThan((tint >> 8) & 255)
      expect((tint >> 8) & 255).toBeGreaterThan(tint & 255)
    }
    system.destroy()
  })
})
