import { CanvasSource, Container, NineSliceSprite, Sprite, Texture } from 'pixi.js'
import type { NoteMaterial } from './NoteMaterial'

interface LacquerNote {
  body: NineSliceSprite
  sheen: Sprite
  specular: Sprite
  gold: Sprite
  light: Sprite
}

// Oxblood lacquer, antique-gold inlay and a soft moving studio reflection.
// The dark interior carries the material; the warm metal is deliberately
// confined to the fine bevel, a few branching seams and the strike light.
export class LacquerNotes implements NoteMaterial {
  readonly container = new Container({ label: 'lacquer-gold-notes' })
  private lights = new Container()
  private notes = new Container()
  private pool: LacquerNote[] = []
  private textures = new Map<number, Texture>()
  private sheenTexture = makeSheen()
  private specularTexture = makeSheen(true)
  private goldTextures = [makeGold(17), makeGold(43), makeGold(79)]
  private lightTexture = makeLight()
  private used = 0
  private strikeLineY = Number.POSITIVE_INFINITY

  setViewport(_width: number, height: number): void {
    this.strikeLineY = height
  }

  constructor() {
    this.container.addChild(this.lights, this.notes)
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
      texture = makeLacquer(color)
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
      const sheen = new Sprite(this.sheenTexture)
      const specular = new Sprite(this.specularTexture)
      const gold = new Sprite(this.goldTextures[0])
      const light = new Sprite(this.lightTexture)
      // Keep body/inlay/reflections in the same normal-blend batch. Switching
      // normal → add for every note forced two GPU draws per note. Normal
      // compositing also preserves occlusion where adjacent notes overlap;
      // the separate strike-light layer remains additive.
      light.blendMode = 'add'
      light.anchor.set(0.5, 0.5)
      this.lights.addChild(light)
      this.notes.addChild(body, gold, sheen, specular)
      note = { body, sheen, specular, gold, light }
      this.pool.push(note)
    }
    const { body, sheen, specular, gold, light } = note
    body.visible = true
    body.texture = texture
    body.position.set(x, y)
    body.setSize(width, height)
    body.alpha = alpha

    const angle = time * 0.86 + seed * 0.37
    const phase = 0.5 + 0.5 * Math.sin(angle)
    const innerH = Math.max(0, height - 8)
    sheen.visible = specular.visible = gold.visible = width > 5 && innerH > 3
    const sheenH = Math.min(110, innerH * 0.72)
    sheen.position.set(x + width * 0.09, y + 4 + phase * Math.max(0, innerH - sheenH))
    sheen.width = width * 0.82
    sheen.height = sheenH
    // A warm studio light is reflected by the clear finish, retaining its
    // colour rather than being multiplied into the dark oxblood pigment.
    sheen.tint = 0xf4ceb1
    sheen.alpha = alpha * (active ? 0.53 : 0.39)
    const specularH = Math.min(52, innerH * 0.34)
    specular.position.set(x + width * 0.09, y + 4 + phase * Math.max(0, innerH - specularH))
    specular.width = width * 0.82
    specular.height = specularH
    specular.tint = 0xffedcf
    // One crisp leading reflection and its soft echo; the dark body remains
    // exposed on either side of the narrow moving highlight.
    specular.alpha = alpha * (0.42 + 0.2 * Math.sin(phase * Math.PI) + (active ? 0.12 : 0))
    gold.texture = this.goldTextures[Math.abs(Math.floor(seed * 7)) % 3]!
    gold.position.set(x + width * 0.13, y + 4)
    gold.width = width * 0.74
    gold.height = innerH
    gold.tint = 0xeac88a
    const goldCatch = (0.5 + 0.5 * Math.sin(angle + 0.55)) ** 6
    gold.alpha = alpha * (0.4 + goldCatch * 0.43 + (active ? 0.1 : 0))

    light.visible = active
    if (active) {
      const hit = Math.exp(-Math.max(0, time - onset) * 6)
      light.position.set(x + width / 2, Math.min(y + height, this.strikeLineY) - 2)
      light.width = width * 3.4 + 12
      light.height = 40 + hit * 32
      light.tint = 0xe4b86e
      light.alpha = alpha * (0.24 + hit * 0.36)
    }
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) {
      const n = this.pool[i]!
      n.body.visible =
        n.sheen.visible =
        n.specular.visible =
        n.gold.visible =
        n.light.visible =
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
    for (const texture of this.goldTextures) texture.destroy(true)
    this.sheenTexture.destroy(true)
    this.specularTexture.destroy(true)
    this.lightTexture.destroy(true)
  }
}

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width * 2
  canvas.height = height * 2
  const ctx = canvas.getContext('2d')!
  ctx.scale(2, 2)
  return { canvas, ctx }
}
function asTexture(canvas: HTMLCanvasElement): Texture {
  return new Texture({ source: new CanvasSource({ resource: canvas, resolution: 2 }) })
}
function randomSource(seed: number) {
  let state = seed
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0
    return (state >>> 0) / 4294967296
  }
}
function makeLacquer(color: number): Texture {
  const { canvas, ctx } = makeCanvas(64, 192)
  ctx.beginPath()
  ctx.roundRect(0.5, 0.5, 63, 191, 3.5)
  ctx.clip()
  const tinted = (amount: number) =>
    `rgb(${Math.round(23 + ((color >> 16) & 255) * amount)},${Math.round(9 + ((color >> 8) & 255) * amount * 0.6)},${Math.round(17 + (color & 255) * amount * 0.8)})`
  const body = ctx.createLinearGradient(0, 0, 64, 0)
  body.addColorStop(0, '#382320')
  body.addColorStop(0.07, tinted(0.22))
  body.addColorStop(0.23, tinted(0.38))
  body.addColorStop(0.5, tinted(0.08))
  body.addColorStop(0.82, tinted(0.12))
  body.addColorStop(0.96, tinted(0.28))
  body.addColorStop(1, '#36211e')
  ctx.fillStyle = body
  ctx.fillRect(0, 0, 64, 192)
  const random = randomSource(181)
  // Very fine brush marks under the clear lacquer, not exposed scratched metal.
  for (let i = 0; i < 240; i++) {
    const yy = 4 + random() * 184
    ctx.strokeStyle = `rgba(210,167,143,${0.018 + random() * 0.04})`
    ctx.lineWidth = 0.3
    ctx.beginPath()
    ctx.moveTo(5, yy)
    ctx.bezierCurveTo(22, yy - 2, 38, yy + 2, 59, yy - 0.5)
    ctx.stroke()
  }
  // Broken gold-leaf edge: bright on the lit side, softly oxidised opposite.
  const edge = ctx.createLinearGradient(0, 0, 64, 0)
  edge.addColorStop(0, '#f0d59a')
  edge.addColorStop(0.3, '#b68b49')
  edge.addColorStop(0.7, '#70512f')
  edge.addColorStop(1, '#c9a664')
  ctx.strokeStyle = edge
  ctx.lineWidth = 0.9
  ctx.beginPath()
  ctx.roundRect(0.9, 0.9, 62.2, 190.2, 3)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(241,211,153,0.2)'
  ctx.lineWidth = 0.5
  ctx.beginPath()
  ctx.roundRect(3, 3, 58, 186, 2)
  ctx.stroke()
  const lip = ctx.createLinearGradient(0, 187, 0, 192)
  lip.addColorStop(0, 'rgba(217,169,92,0)')
  lip.addColorStop(1, 'rgba(247,219,160,0.48)')
  ctx.fillStyle = lip
  ctx.fillRect(4, 187, 56, 4)
  return asTexture(canvas)
}
function makeGold(seed: number): Texture {
  const { canvas, ctx } = makeCanvas(64, 192)
  const random = randomSource(seed)
  for (let branch = 0; branch < 3; branch++) {
    let x = 10 + random() * 44
    let y = branch * 58 + 6
    ctx.strokeStyle = 'rgba(255,245,211,0.7)'
    ctx.lineWidth = 0.45
    ctx.beginPath()
    ctx.moveTo(x, y)
    for (let k = 0; k < 6; k++) {
      x = Math.max(4, Math.min(60, x + (random() - 0.5) * 22))
      y += 5 + random() * 5
      ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  for (let i = 0; i < 65; i++) {
    ctx.fillStyle = `rgba(255,235,182,${0.2 + random() * 0.35})`
    ctx.fillRect(random() * 64, random() * 192, 0.4 + random() * 0.6, 0.6)
  }
  return asTexture(canvas)
}
function makeSheen(crisp = false): Texture {
  const { canvas, ctx } = makeCanvas(64, 128)
  const sheen = ctx.createLinearGradient(0, 0, 30, 128)
  sheen.addColorStop(0, 'rgba(255,255,255,0)')
  if (crisp) {
    sheen.addColorStop(0.34, 'rgba(255,255,255,0)')
    sheen.addColorStop(0.44, 'rgba(255,255,255,0.15)')
    sheen.addColorStop(0.485, 'rgba(255,255,255,0.92)')
    sheen.addColorStop(0.515, 'rgba(255,255,255,0.42)')
    sheen.addColorStop(0.57, 'rgba(255,255,255,0.025)')
    sheen.addColorStop(0.69, 'rgba(255,255,255,0.15)')
    sheen.addColorStop(0.77, 'rgba(255,255,255,0)')
  } else {
    sheen.addColorStop(0.23, 'rgba(255,255,255,0.03)')
    sheen.addColorStop(0.48, 'rgba(255,255,255,0.5)')
    sheen.addColorStop(0.59, 'rgba(255,255,255,0.2)')
    sheen.addColorStop(0.8, 'rgba(255,255,255,0.02)')
  }
  sheen.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = sheen
  ctx.fillRect(0, 0, 64, 128)
  const edgeFade = ctx.createLinearGradient(0, 0, 64, 0)
  edgeFade.addColorStop(0, 'rgba(255,255,255,0)')
  edgeFade.addColorStop(0.17, 'rgba(255,255,255,1)')
  edgeFade.addColorStop(0.72, 'rgba(255,255,255,1)')
  edgeFade.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = edgeFade
  ctx.fillRect(0, 0, 64, 128)
  return asTexture(canvas)
}
function makeLight(): Texture {
  const { canvas, ctx } = makeCanvas(64, 64)
  const light = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  light.addColorStop(0, 'rgba(255,255,255,0.9)')
  light.addColorStop(0.18, 'rgba(255,255,255,0.4)')
  light.addColorStop(0.5, 'rgba(255,255,255,0.07)')
  light.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = light
  ctx.fillRect(0, 0, 64, 64)
  return asTexture(canvas)
}
