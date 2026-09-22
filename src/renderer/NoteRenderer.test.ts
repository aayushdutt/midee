import { Container } from 'pixi.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MidiTrack } from '../core/midi/types'
import { createNoteMaterial } from './createNoteMaterial'
import { NoteRenderer } from './NoteRenderer'
import { THEMES } from './theme'
import { Viewport } from './viewport'

vi.mock('pixi.js', () => {
  class MockContainer {
    children: MockContainer[] = []
    visible = true
    renderable = true
    label = ''
    mask: MockContainer | null = null
    addChild(child: MockContainer) {
      this.children.push(child)
      return child
    }
    addChildAt(child: MockContainer, index: number) {
      this.children.splice(index, 0, child)
      return child
    }
    destroy() {}
  }
  class MockGraphics extends MockContainer {
    clear() {
      return this
    }
    rect = vi.fn(() => this)
    roundRect = vi.fn(() => this)
    fill() {
      return this
    }
  }
  return { Container: MockContainer, Graphics: MockGraphics }
})
vi.mock('pixi-filters', () => ({
  GlowFilter: class {
    constructor(public options: { distance: number }) {}
    get distance() {
      return this.options.distance
    }
    destroy() {}
  },
}))
vi.mock('./noteLabels', () => ({
  NoteLabelLayer: class {
    container = new Container()
    isActive = false
    clear() {}
  },
}))
vi.mock('./createNoteMaterial', () => ({ createNoteMaterial: vi.fn() }))

const track: MidiTrack = {
  id: 'held-note',
  name: 'Piano',
  channel: 0,
  instrument: 0,
  isDrum: false,
  colorIndex: 0,
  notes: [{ pitch: 60, time: 2, duration: 4, velocity: 0.8 }],
}

beforeEach(() => {
  vi.mocked(createNoteMaterial).mockImplementation(() => ({
    container: new Container(),
    setViewport: vi.fn(),
    begin: vi.fn(),
    place: vi.fn(),
    end: vi.fn(),
    clear: vi.fn(),
    destroy: vi.fn(),
  }))
})

describe('material note consumption', () => {
  for (const theme of THEMES.filter((theme) => theme.noteMaterial)) {
    it(`${theme.name} keeps its texture dimensions while crossing the keyboard`, () => {
      const viewport = new Viewport({
        canvasWidth: 800,
        canvasHeight: 500,
        keyboardHeight: 100,
        pixelsPerSecond: 100,
      })
      const renderer = new NoteRenderer(theme)
      renderer.setTracks([track])
      const material = vi.mocked(createNoteMaterial).mock.results.at(-1)!.value
      const place = vi.mocked(material.place)
      for (const time of [1, 2, 3, 5.99]) {
        renderer.draw([track], time, viewport, new Set([track.id]), null)
        const args = place.mock.calls.at(-1)!
        expect(args[3]).toBe(400)
        expect(args[1]).toBeCloseTo(400 - (6 - time) * 100)
        expect(material.container.mask).not.toBeNull()
        // Pixi masks must remain renderable for their stencil pass; Pixi
        // itself excludes them from normal scene drawing.
        expect(material.container.mask).toMatchObject({ visible: true, renderable: true })
      }
      // Seek back and change zoom: dimensions follow duration × zoom, never
      // remaining duration. The clip follows the resized strike line.
      viewport.update({ pixelsPerSecond: 150, canvasHeight: 600 })
      renderer.draw([track], 3, viewport, new Set([track.id]), null)
      expect(place.mock.calls.at(-1)![3]).toBe(600)
      expect(material.setViewport).toHaveBeenLastCalledWith(800, 500)
      place.mockClear()
      renderer.draw([track], 6, viewport, new Set([track.id]), null)
      expect(place).not.toHaveBeenCalled()
      const clip = material.container.mask
      renderer.updateTheme(THEMES[0]!)
      expect(clip).toMatchObject({ visible: false })
      renderer.updateTheme(theme)
      expect(clip).toMatchObject({ visible: true, renderable: true })
      renderer.destroy()
    })
  }
})
