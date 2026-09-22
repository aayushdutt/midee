import { CanvasSource, Container, NineSliceSprite, Sprite, Texture } from 'pixi.js'

// One reusable material for scheduled, held, released and loop notes. Textures
// are baked once per colour; moving a note updates sprites, never its geometry.
// All animation is sampled from musical time so seeks / export / static frames
// have the same reflection and strike light at the same time.
interface GlassNote {
  body: NineSliceSprite
  reflection: Sprite
  refraction: Sprite
  specular: Sprite
  light: Sprite
  caustic: Sprite
}

export class SmokedGlassNotes {
  readonly container = new Container({ label: 'smoked-glass-notes' })
  private lights = new Container()
  private bodies = new Container()
  private textures = new Map<number, Texture>()
  private reflectionTexture = makeReflection()
  private refractionTexture = makeRefraction()
  private specularTexture = makeSpecular()
  private lightTexture = makeOpticalLight()
  private pool: GlassNote[] = []
  private used = 0
  private strikeLineY = Number.POSITIVE_INFINITY

  setViewport(_width: number, height: number): void {
    this.strikeLineY = height
  }

  constructor() {
    this.container.addChild(this.lights, this.bodies)
  }

  begin(): void {
    this.used = 0
    this.container.visible = true
  }

  place(
    x: number,
    y: number,
    width: number,
    height: number,
    color: number,
    alpha: number,
    time: number,
    onset: number,
    seed: number,
    active: boolean,
  ): void {
    let texture = this.textures.get(color)
    if (!texture) {
      texture = makeGlassTexture(color)
      this.textures.set(color, texture)
    }
    let note = this.pool[this.used++]
    if (!note) {
      const body = new NineSliceSprite({
        texture,
        leftWidth: 4,
        rightWidth: 4,
        topHeight: 5,
        bottomHeight: 5,
      })
      const reflection = new Sprite(this.reflectionTexture)
      const refraction = new Sprite(this.refractionTexture)
      const specular = new Sprite(this.specularTexture)
      const light = new Sprite(this.lightTexture)
      const caustic = new Sprite(this.lightTexture)
      refraction.blendMode = reflection.blendMode = light.blendMode = caustic.blendMode = 'add'
      specular.blendMode = 'add'
      light.anchor.set(0.5, 0.5)
      caustic.anchor.set(0.5, 0.5)
      this.lights.addChild(light, caustic)
      this.bodies.addChild(body, refraction, reflection, specular)
      note = { body, reflection, refraction, specular, light, caustic }
      this.pool.push(note)
    }
    const { body, reflection, refraction, specular, light, caustic } = note
    body.texture = texture
    body.position.set(x, y)
    body.setSize(width, height)
    body.alpha = alpha
    body.visible = true

    // A broad, angled reflection behind the surface. Phase is stable for each
    // note, with a slow sweep; it never shifts the silhouette or obscures labels.
    const phase = (((time * 0.12 + seed * 0.173) % 1) + 1) % 1
    const reflectionH = Math.min(90, Math.max(0, height - 8))
    reflection.visible = width > 5 && reflectionH > 3
    reflection.position.set(x + width * 0.16, y + 4 + phase * Math.max(0, height - reflectionH - 8))
    reflection.width = width * 0.68
    reflection.height = reflectionH
    reflection.tint = color
    reflection.alpha = alpha * (active ? 0.5 : 0.34) * Math.sin(phase * Math.PI)

    // A separate internal optical layer catches light at a different rate
    // from the surface reflection. Keep it inset: no per-note clipping pass.
    const innerH = Math.min(180, Math.max(0, height - 10))
    const innerPhase = 0.5 + 0.5 * Math.sin(time * 0.55 + seed * 1.71)
    refraction.visible = width > 7 && innerH > 8
    refraction.position.set(
      x + width * 0.15,
      y + 5 + innerPhase * Math.max(0, height - innerH - 10),
    )
    refraction.width = width * 0.7
    refraction.height = innerH
    refraction.tint = color
    refraction.alpha = alpha * (active ? 0.38 : 0.23)

    // A focused softbox reflection travels independently from the internal
    // striae. Its silver crest reveals the surface over the dark optical core.
    // Coordinates belong to the complete note, so clipping never squeezes it.
    const lightPhase = 0.5 + 0.5 * Math.sin(time * 0.7 + seed * 0.73)
    const specularH = Math.min(120, Math.max(0, height - 6))
    specular.visible = width > 4 && specularH > 3
    specular.position.set(
      x + width * 0.08,
      y + 3 + lightPhase * Math.max(0, height - specularH - 6),
    )
    specular.width = width * 0.84
    specular.height = specularH
    specular.tint = 0xe5f5ff
    specular.alpha = alpha * (0.36 + 0.17 * Math.sin(lightPhase * Math.PI) + (active ? 0.12 : 0))

    const impulse = active ? Math.exp(-Math.max(0, time - onset) * 7) : 0
    light.visible = caustic.visible = active
    if (active) {
      // Local, colour-preserving light. Wide chords never acquire an averaged
      // grey halo, and the whole note roll needs no offscreen filter pass.
      const strikeY = Math.min(y + height, this.strikeLineY)
      light.position.set(x + width * 0.5, strikeY - 8)
      light.width = width * 3.4 + 16
      light.height = 88 + impulse * 36
      light.tint = color
      light.alpha = alpha * (0.2 + impulse * 0.22)
      caustic.position.set(x + width * 0.5, strikeY - 1.5)
      caustic.width = width * (2.4 + impulse) + 8
      caustic.height = 10 + impulse * 9
      caustic.tint = color
      caustic.alpha = alpha * (0.5 + impulse * 0.45)
    }
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) {
      const note = this.pool[i]!
      note.body.visible =
        note.reflection.visible =
        note.refraction.visible =
        note.specular.visible =
        note.light.visible =
        note.caustic.visible =
          false
    }
  }

  clear(): void {
    this.used = 0
    this.end()
    this.container.visible = false
  }

  destroy(): void {
    this.container.destroy({ children: true })
    for (const texture of this.textures.values()) texture.destroy(true)
    this.reflectionTexture.destroy(true)
    this.refractionTexture.destroy(true)
    this.specularTexture.destroy(true)
    this.lightTexture.destroy(true)
  }
}

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return [c, c.getContext('2d')!]
}

function rgb(color: number, scale: number, white = 0): string {
  const channel = (shift: number) => Math.round(((color >> shift) & 255) * scale + 255 * white)
  return `rgb(${channel(16)},${channel(8)},${channel(0)})`
}

function makeGlassTexture(color: number): Texture {
  // Supersampled bevels stay fine at DPR 2 and in export. Nine-slicing keeps
  // the polished cap / rim a constant thickness on long and very short notes.
  const [c, ctx] = canvas(128, 384)
  ctx.scale(2, 2)
  ctx.beginPath()
  ctx.roundRect(0.5, 0.5, 63, 191, 4.5)
  ctx.clip()

  // Reflected light on the left, a deep transparent-looking core, and a
  // narrower secondary reflection on the right. The dark body is essential:
  // filling everything with cyan makes glass look like a glowing plastic bar.
  const cross = ctx.createLinearGradient(0, 0, 64, 0)
  for (const [at, strength] of [
    [0, 0.72],
    [0.035, 0.3],
    [0.075, 0.62],
    [0.13, 0.38],
    [0.24, 0.52],
    [0.4, 0.29],
    [0.66, 0.18],
    [0.85, 0.27],
    [0.94, 0.48],
    [0.98, 0.22],
    [1, 0.65],
  ]) {
    cross.addColorStop(at!, rgb(color, strength!))
  }
  ctx.fillStyle = cross
  ctx.fillRect(0, 0, 64, 192)

  const depth = ctx.createLinearGradient(0, 0, 0, 192)
  depth.addColorStop(0, 'rgba(4,10,20,0.23)')
  depth.addColorStop(0.22, 'rgba(197,234,244,0.025)')
  depth.addColorStop(0.7, 'rgba(4,10,20,0.12)')
  depth.addColorStop(1, 'rgba(197,234,244,0.24)')
  ctx.fillStyle = depth
  ctx.fillRect(0, 0, 64, 192)

  // Very fine striae suspended inside cast glass. Curves, rather than a
  // regular grid, keep this organic; their bright/dark pairs imply refraction.
  for (let i = 0; i < 13; i++) {
    const x = 7 + i * 4.1
    for (const offset of [0, 0.9]) {
      ctx.strokeStyle = offset
        ? 'rgba(3,13,24,0.16)'
        : `rgba(204,238,248,${0.035 + (i % 3) * 0.025})`
      ctx.lineWidth = offset ? 0.8 : 0.45
      ctx.beginPath()
      ctx.moveTo(x + offset, 4)
      ctx.bezierCurveTo(x - 7 + offset, 65, x + 9 + offset, 122, x - 2 + offset, 188)
      ctx.stroke()
    }
  }

  // Fine, deterministic grain and sparse pinprick inclusions. A small hash
  // avoids the diagonal repeat pattern of a linear x/y scatter.
  let noise = 9137
  const random = () => {
    noise = (Math.imul(noise, 1664525) + 1013904223) | 0
    return (noise >>> 0) / 4294967296
  }
  for (let i = 0; i < 1600; i++) {
    const x = 4 + random() * 56
    const y = 5 + random() * 182
    ctx.fillStyle = `rgba(215,240,247,${0.035 + random() * 0.065})`
    ctx.fillRect(x, y, 0.3 + random() * 0.45, 0.3 + random() * 0.55)
  }

  // Off-centre specular streak and faint etched inner edge.
  const streak = ctx.createLinearGradient(0, 0, 25, 0)
  streak.addColorStop(0, 'rgba(218,244,250,0)')
  streak.addColorStop(0.3, 'rgba(218,244,250,0.05)')
  streak.addColorStop(0.42, 'rgba(218,244,250,0.34)')
  streak.addColorStop(0.55, 'rgba(218,244,250,0.06)')
  streak.addColorStop(1, 'rgba(218,244,250,0)')
  ctx.fillStyle = streak
  ctx.fillRect(0, 3, 25, 186)
  ctx.strokeStyle = rgb(color, 0.38, 0.42)
  ctx.lineWidth = 0.7
  ctx.beginPath()
  ctx.roundRect(0.75, 0.75, 62.5, 190.5, 4)
  ctx.stroke()
  // A dark inner seam separates the bevel from the optical core.
  ctx.strokeStyle = 'rgba(4,13,23,0.44)'
  ctx.lineWidth = 0.6
  ctx.beginPath()
  ctx.roundRect(3.2, 3, 57.6, 186, 2.5)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(224,245,250,0.56)'
  ctx.lineWidth = 0.65
  ctx.beginPath()
  ctx.moveTo(1.7, 7)
  ctx.lineTo(1.7, 185)
  ctx.stroke()
  const lip = ctx.createLinearGradient(4, 0, 60, 0)
  lip.addColorStop(0, 'rgba(225,247,252,0.15)')
  lip.addColorStop(0.25, 'rgba(242,252,255,0.85)')
  lip.addColorStop(1, 'rgba(175,224,240,0.22)')
  ctx.fillStyle = lip
  ctx.fillRect(5, 189.5, 54, 0.85)
  ctx.fillStyle = 'rgba(226,245,251,0.24)'
  ctx.fillRect(6, 2, 48, 0.6)
  return new Texture({ source: new CanvasSource({ resource: c, resolution: 2 }) })
}

function makeRefraction(): Texture {
  const [c, ctx] = canvas(64, 256)
  const fade = ctx.createLinearGradient(0, 0, 0, 256)
  fade.addColorStop(0, 'rgba(255,255,255,0)')
  fade.addColorStop(0.3, 'rgba(255,255,255,0.1)')
  fade.addColorStop(0.56, 'rgba(255,255,255,0.55)')
  fade.addColorStop(0.72, 'rgba(255,255,255,0.16)')
  fade.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.strokeStyle = fade
  for (let i = 0; i < 5; i++) {
    ctx.lineWidth = i === 2 ? 1.4 : 0.65
    ctx.beginPath()
    ctx.moveTo(6 + i * 4, 0)
    ctx.bezierCurveTo(61 - i * 3, 92, 8 + i * 2, 158, 54 - i * 4, 256)
    ctx.stroke()
  }
  return Texture.from(c)
}

function makeReflection(): Texture {
  const [c, ctx] = canvas(32, 96)
  const gradient = ctx.createLinearGradient(0, 0, 24, 96)
  gradient.addColorStop(0, 'rgba(255,255,255,0)')
  gradient.addColorStop(0.4, 'rgba(255,255,255,0)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.2)')
  gradient.addColorStop(0.52, 'rgba(255,255,255,0.65)')
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.1)')
  gradient.addColorStop(0.64, 'rgba(255,255,255,0.05)')
  gradient.addColorStop(0.68, 'rgba(255,255,255,0.32)')
  gradient.addColorStop(0.71, 'rgba(255,255,255,0.02)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 32, 96)
  return Texture.from(c)
}

function makeSpecular(): Texture {
  const [c, ctx] = canvas(96, 256)
  const window = ctx.createLinearGradient(0, 0, 84, 256)
  window.addColorStop(0, 'rgba(255,255,255,0)')
  window.addColorStop(0.28, 'rgba(234,249,255,0)')
  window.addColorStop(0.43, 'rgba(234,249,255,0.16)')
  window.addColorStop(0.49, 'rgba(248,253,255,0.48)')
  window.addColorStop(0.515, 'rgba(255,255,255,0.9)')
  window.addColorStop(0.535, 'rgba(235,250,255,0.2)')
  window.addColorStop(0.67, 'rgba(235,250,255,0)')
  window.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = window
  ctx.fillRect(0, 0, 96, 256)
  ctx.globalCompositeOperation = 'destination-in'
  const edge = ctx.createLinearGradient(0, 0, 96, 0)
  edge.addColorStop(0, 'rgba(0,0,0,0)')
  edge.addColorStop(0.15, 'rgba(0,0,0,1)')
  edge.addColorStop(0.78, 'rgba(0,0,0,1)')
  edge.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = edge
  ctx.fillRect(0, 0, 96, 256)
  return Texture.from(c)
}

function makeOpticalLight(): Texture {
  const [c, ctx] = canvas(96, 96)
  const gradient = ctx.createRadialGradient(48, 48, 0, 48, 48, 48)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.16, 'rgba(255,255,255,0.48)')
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.12)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 96, 96)
  return Texture.from(c)
}

// A fixed, low-resolution atmospheric plate: midnight above, reflected cyan
// near the keys, with darker corners. Stretched only when the viewport changes.
export function makeGlassAtmosphere(): Texture {
  const [c, ctx] = canvas(512, 512)
  const wash = ctx.createLinearGradient(0, 0, 0, 512)
  wash.addColorStop(0, '#080e18')
  wash.addColorStop(0.65, '#0b1826')
  wash.addColorStop(1, '#152a39')
  ctx.fillStyle = wash
  ctx.fillRect(0, 0, 512, 512)
  const vignette = ctx.createRadialGradient(256, 390, 50, 256, 300, 390)
  vignette.addColorStop(0, 'rgba(3,8,16,0)')
  vignette.addColorStop(1, 'rgba(3,8,16,0.76)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, 512, 512)
  return Texture.from(c)
}
