import { CanvasSource, Container, Sprite, Texture } from 'pixi.js'
import type { Viewport } from '../viewport'

interface ContactLight {
  mist: Sprite
  reflection: Sprite
}

/**
 * A fine champagne reflection where the roll meets the piano. The note
 * material supplies the impact flare; this layer quietly joins that light
 * to the keyboard edge, with a little sideways diffusion at sounding keys.
 *
 * Every frame is a pure sample of active pitches and musical time. There is
 * deliberately no onset history or release simulation to diverge on a seek.
 */
export class EmberMistStrike {
  readonly container = new Container({ label: 'ember-mist-strike', eventMode: 'none' })
  private readonly seamTexture = makeTexture('seam')
  private readonly mistTexture = makeTexture('mist')
  private readonly reflectionTexture = makeTexture('reflection')
  private readonly seam = new Sprite(this.seamTexture)
  private readonly contacts = new Map<number, ContactLight>()

  constructor() {
    this.seam.anchor.set(0.5)
    this.seam.blendMode = 'add'
    this.seam.tint = 0xffd39a
    this.container.addChild(this.seam)
  }

  update(viewport: Viewport, activePitches: ReadonlyMap<number, number>, time: number): void {
    this.container.visible = true
    const lineY = viewport.nowLineY
    const width = viewport.config.canvasWidth
    this.seam.position.set(width * 0.5, lineY)
    this.seam.width = width
    this.seam.height = 16

    for (const contact of this.contacts.values()) {
      contact.mist.visible = contact.reflection.visible = false
    }

    // Dense chords gain coverage, not a large uniform strip of white. Scaling
    // only the local reflections leaves the quiet continuous seam unchanged.
    let visibleCount = 0
    for (const pitch of activePitches.keys()) {
      if (viewport.hasKey(pitch)) visibleCount++
    }
    const density = 1 / Math.sqrt(1 + Math.max(0, visibleCount - 4) * 0.08)

    for (const [pitch, color] of activePitches) {
      if (!viewport.hasKey(pitch)) continue
      let contact = this.contacts.get(pitch)
      if (!contact) {
        const mist = new Sprite(this.mistTexture)
        const reflection = new Sprite(this.reflectionTexture)
        mist.anchor.set(0.5)
        reflection.anchor.set(0.5)
        mist.blendMode = reflection.blendMode = 'add'
        this.container.addChild(mist, reflection)
        contact = { mist, reflection }
        this.contacts.set(pitch, contact)
      }
      const keyWidth = viewport.pitchWidth(pitch)
      const center = viewport.pitchToX(pitch) + keyWidth * 0.5
      const phase = time * 0.86 + pitch * 0.618
      const spread = 0.5 + 0.5 * Math.sin(phase)
      const breath = 0.92 + 0.08 * Math.sin(phase * 1.31 + 0.7)
      // Mostly champagne, with a little of the note's warm pigment reflected
      // in the surrounding mist. It never becomes a saturated neon underlight.
      const tint = warmReflection(color)

      contact.mist.visible = contact.reflection.visible = true
      contact.mist.position.set(center, lineY - 1.3)
      contact.mist.width = Math.min(180, keyWidth * (3.1 + spread * 0.45) + 10)
      contact.mist.height = 13 + spread * 3
      contact.mist.tint = tint
      contact.mist.alpha = 0.17 * density * breath

      contact.reflection.position.set(center, lineY - 0.15)
      contact.reflection.width = Math.min(150, keyWidth * (2.1 + spread * 0.6) + 8)
      contact.reflection.height = 4
      contact.reflection.tint = 0xffdda9
      contact.reflection.alpha = 0.44 * density * breath
    }
  }

  clear(): void {
    this.container.visible = false
    for (const contact of this.contacts.values()) {
      contact.mist.visible = contact.reflection.visible = false
    }
  }

  destroy(): void {
    this.container.destroy({ children: true })
    this.seamTexture.destroy(true)
    this.mistTexture.destroy(true)
    this.reflectionTexture.destroy(true)
    this.contacts.clear()
  }
}

function warmReflection(color: number): number {
  const warm = 0xf2c18b
  const channel = (shift: number) =>
    Math.round(((warm >> shift) & 255) * 0.83 + ((color >> shift) & 255) * 0.17)
  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

function makeTexture(kind: 'seam' | 'mist' | 'reflection'): Texture {
  const width = kind === 'seam' ? 512 : 192
  const height = 48
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')!
  const pixels = context.createImageData(width, height)

  for (let y = 0; y < height; y++) {
    const dy = (y - (height - 1) * 0.5) / (height * 0.5)
    for (let x = 0; x < width; x++) {
      const dx = (x - (width - 1) * 0.5) / (width * 0.5)
      let opacity: number
      if (kind === 'seam') {
        // One roughly pixel-thin lit edge with a tiny soft shoulder. The
        // margin fades gently to nothing at the extreme ends of the piano.
        const ends = Math.min(1, (1 - Math.abs(dx)) * 16)
        opacity = ends * (0.52 * Math.exp(-dy * dy * 430) + 0.034 * Math.exp(-dy * dy * 15))
      } else if (kind === 'reflection') {
        const taper = Math.max(0, 1 - dx * dx) ** 2.5
        opacity = taper * (0.85 * Math.exp(-dy * dy * 48) + 0.08 * Math.exp(-dy * dy * 5))
      } else {
        const radius = dx * dx * 2.1 + dy * dy * 3
        opacity = Math.exp(-radius * 2.3) * Math.max(0, 1 - dx * dx) * Math.max(0, 1 - dy * dy)
      }
      const index = (y * width + x) * 4
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = 255
      pixels.data[index + 3] = Math.min(255, Math.round(opacity * 255))
    }
  }
  context.putImageData(pixels, 0, 0)
  return new Texture({ source: new CanvasSource({ resource: canvas, resolution: 2 }) })
}
