import { CanvasSource, Container, NineSliceSprite, Sprite, Texture } from 'pixi.js'
import type { NoteMaterial } from './NoteMaterial'

type NaturalKind = 'aurora-silk' | 'opal'

interface NaturalNote {
  body: NineSliceSprite
  veil: Sprite
  glimmer: Sprite
  light: Sprite
  contact: Sprite
}

/**
 * Two tactile materials, sharing only their resource lifecycle. Silk is dark,
 * directional and folded; opal is softly carved, cloudy and pearlescent.
 * Static detail is baked once per colour, while all motion samples song time.
 * No per-note canvases, geometry rebuilds, filters, or simulation state.
 */
export class NaturalMaterialNotes implements NoteMaterial {
  readonly container: Container
  private readonly bodies = new Container()
  private readonly lights = new Container()
  private readonly textures = new Map<number, Texture>()
  private readonly veilTexture: Texture
  private readonly glimmerTexture: Texture
  private readonly lightTexture = makeLight()
  private readonly pool: NaturalNote[] = []
  private used = 0
  private visibleCount = 0
  private strikeLineY = Infinity

  constructor(private readonly kind: NaturalKind) {
    this.container = new Container({ label: `${kind}-notes` })
    this.veilTexture = kind === 'aurora-silk' ? makeSilkVeil(false) : makePearlVeil(false)
    this.glimmerTexture = kind === 'aurora-silk' ? makeSilkVeil(true) : makePearlVeil(true)
    this.container.addChild(this.lights, this.bodies)
  }

  setViewport(_width: number, height: number): void {
    this.strikeLineY = height
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
      texture = makeBody(this.kind, color)
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
      const veil = new Sprite(this.veilTexture)
      const glimmer = new Sprite(this.glimmerTexture)
      const light = new Sprite(this.lightTexture)
      const contact = new Sprite(this.lightTexture)
      veil.blendMode = glimmer.blendMode = light.blendMode = contact.blendMode = 'add'
      // Pearl's moving colour lives beneath its white surface reflection.
      // Normal blending preserves rose/jade chroma instead of bleaching it.
      if (this.kind === 'opal') veil.blendMode = 'normal'
      light.anchor.set(0.5)
      contact.anchor.set(0.5)
      this.lights.addChild(light, contact)
      this.bodies.addChild(body, veil, glimmer)
      note = { body, veil, glimmer, light, contact }
      this.pool.push(note)
    }
    const { body, veil, glimmer, light, contact } = note
    const silk = this.kind === 'aurora-silk'
    body.texture = texture
    body.position.set(x, y)
    // Pixi invalidates nine-slice geometry even for an identical setSize.
    // Scrolling and consuming a scheduled note only changes its position.
    if (body.width !== width || body.height !== height) body.setSize(width, height)
    body.alpha = alpha
    body.visible = true

    // Broad folds breathe slowly, rather than scrolling a texture in lockstep.
    // Both layers have transparent margins, so they remain inside the body
    // without a scissor/mask pass, even for tiny notes.
    const phase = time * (silk ? 0.94 : 0.52) + seed * 0.37
    const phaseSin = Math.sin(phase)
    const inset = Math.min(3, width * 0.15)
    const innerWidth = Math.max(0, width - inset * 2)
    const innerHeight = Math.max(0, height - 8)
    // Leave travel on short notes too. A full-height overlay can only pulse;
    // a bounded patch visibly rolls across even a 16px-wide sixteenth note.
    const veilHeight = Math.min(silk ? 200 : 150, innerHeight * 0.78)
    const veilTravel = Math.max(0, innerHeight - veilHeight)
    veil.visible = glimmer.visible = innerWidth > 3 && innerHeight > 4
    veil.position.set(
      x + inset + (0.03 + phaseSin * 0.025) * innerWidth,
      y + 4 + (0.5 + 0.5 * phaseSin) * veilTravel,
    )
    veil.width = innerWidth * 0.93
    veil.height = veilHeight
    veil.tint = silk
      ? mixColor(color, 0xdff2e3, 0.58)
      : mixColor(0x9edcc4, 0xedb9ce, 0.5 + 0.5 * Math.sin(phase * 0.73))
    veil.alpha =
      alpha * (silk ? (active ? 0.61 : 0.48) : 0.46) * (0.82 + 0.18 * Math.sin(phase + 1))

    const glimmerHeight = Math.min(silk ? 115 : 100, innerHeight * 0.5)
    const glimmerTravel = Math.max(0, innerHeight - glimmerHeight)
    glimmer.position.set(
      x + inset + innerWidth * 0.03,
      y + 4 + (0.5 + 0.5 * Math.sin(phase * 0.82 + 1.9)) * glimmerTravel,
    )
    glimmer.width = innerWidth * 0.92
    glimmer.height = glimmerHeight
    glimmer.tint = silk
      ? 0xe9f4dc
      : mixColor(0xffebd1, 0xd7e9ff, 0.5 + 0.5 * Math.sin(phase * 0.67 + 2))
    glimmer.alpha = alpha * (silk ? 0.63 : 0.48) * (0.75 + 0.25 * Math.cos(phase * 0.8))

    const impulse = active ? Math.exp(-Math.max(0, time - onset) * 5) : 0
    light.visible = contact.visible = active
    if (active) {
      const tint = mixColor(color, silk ? 0xd9eed9 : 0xffecd7, silk ? 0.18 : 0.42)
      const strikeY = Math.min(y + height, this.strikeLineY)
      light.position.set(x + width * 0.5, strikeY - 3)
      light.width = width * (silk ? 3 : 2.5) + 12
      light.height = (silk ? 68 : 44) + impulse * 25
      light.tint = tint
      light.alpha = alpha * (silk ? 0.13 : 0.11) * (1 + impulse)
      contact.position.set(x + width * 0.5, strikeY - 1)
      contact.width = width * (1.8 + impulse * 0.8)
      contact.height = 5 + impulse * (silk ? 12 : 8)
      contact.tint = tint
      contact.alpha = alpha * (0.38 + impulse * 0.35)
      // Light enters silk at the foot; pearl gains a soft surface lustre.
      glimmer.alpha += alpha * impulse * (silk ? 0.16 : 0.1)
    }
  }

  end(): void {
    for (let i = this.used; i < this.visibleCount; i++) {
      const note = this.pool[i]!
      note.body.visible = note.veil.visible = note.glimmer.visible = false
      note.light.visible = note.contact.visible = false
    }
    this.visibleCount = this.used
  }

  clear(): void {
    this.used = 0
    this.end()
    this.container.visible = false
  }

  destroy(): void {
    this.container.destroy({ children: true })
    for (const texture of this.textures.values()) texture.destroy(true)
    this.textures.clear()
    this.veilTexture.destroy(true)
    this.glimmerTexture.destroy(true)
    this.lightTexture.destroy(true)
    this.pool.length = 0
  }
}

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return [canvas, canvas.getContext('2d')!]
}

function mixColor(a: number, b: number, amount: number): number {
  const inverse = 1 - amount
  const r = Math.round(((a >> 16) & 255) * inverse + ((b >> 16) & 255) * amount)
  const g = Math.round(((a >> 8) & 255) * inverse + ((b >> 8) & 255) * amount)
  const blue = Math.round((a & 255) * inverse + (b & 255) * amount)
  return (r << 16) | (g << 8) | blue
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function hash(x: number, y: number): number {
  let n = Math.imul(x + 251, 374761393) + Math.imul(y + 719, 668265263)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const u = x - ix
  const v = y - iy
  const sx = u * u * (3 - 2 * u)
  const sy = v * v * (3 - 2 * v)
  const a = hash(ix, iy) * (1 - sx) + hash(ix + 1, iy) * sx
  const b = hash(ix, iy + 1) * (1 - sx) + hash(ix + 1, iy + 1) * sx
  return a * (1 - sy) + b * sy
}

function makeBody(kind: NaturalKind, color: number): Texture {
  const w = 128
  const h = 384
  const [canvas, ctx] = makeCanvas(w, h)
  const pixels = ctx.createImageData(w, h)
  const channels = [(color >> 16) & 255, (color >> 8) & 255, color & 255]
  const silk = kind === 'aurora-silk'
  // Reuse the palette through the bake instead of allocating colour arrays
  // for every pixel and channel of each cached 128 × 384 body texture.
  const silkHighlight = [222, 243, 224]
  const pearl = [244, 237, 221]
  const green = [144, 219, 193]
  const pink = [232, 153, 180]
  const gold = [245, 212, 148]

  for (let py = 0; py < h; py++) {
    const v = py / (h - 1)
    for (let px = 0; px < w; px++) {
      const u = px / (w - 1)
      const index = (py * w + px) * 4
      // Antialiased rounded silhouette, baked into the resource itself.
      const radius = silk ? 8 : 11
      const dx = Math.max(radius - px, px - (w - 1 - radius), 0)
      const dy = Math.max(radius - py, py - (h - 1 - radius), 0)
      const coverage = clamp(radius - Math.hypot(dx, dy))
      const grain = hash(px, py) - 0.5

      if (silk) {
        // Satin's broad anisotropic sheen is the dominant feature. Two soft,
        // shallow folds catch a large light source; there are no repeated
        // corrugations or high-contrast wavy ridges at small note sizes.
        const bend = Math.sin(v * 3.8 - 0.5) * 0.035
        const broadFold = Math.exp(-((u - 0.3 - bend) ** 2) / 0.038)
        const returnFold = Math.exp(-((u - 0.82 + bend * 0.6) ** 2) / 0.026)
        const softValley = Math.exp(-((u - 0.61 - bend * 0.25) ** 2) / 0.027)
        const edgeLight = Math.exp(-((u - 0.055) ** 2) / 0.0009)
        const edgeShade = 0.77 + 0.23 * clamp(Math.min(u, 1 - u) * 16)
        // The weave is below the sheen, almost imperceptible at playing size.
        // Keeping it longitudinal avoids a woodgrain/moiré pattern on short notes.
        const fiber = Math.sin((u - bend * 0.35) * 402) * 0.0025
        const shading =
          (0.46 + broadFold * 0.27 + returnFold * 0.13 - softValley * 0.07 + fiber) * edgeShade
        const sheen = broadFold * 0.15 + returnFold * 0.055 + edgeLight * 0.12
        for (let ch = 0; ch < 3; ch++) {
          pixels.data[index + ch] =
            channels[ch]! * shading + silkHighlight[ch]! * sheen + grain * 0.9
        }
      } else {
        // Domain-warped mineral regions, with low-contrast shell growth lines.
        // The pearl base dominates; only a few regions show opalescent colour.
        const warp = noise(u * 3 + 3, v * 5) * 0.8
        const mineral = noise(u * 4.2 + warp, v * 6.3 + warp)
        const fine = noise(u * 13 + mineral, v * 22)
        const shell = Math.sin((mineral * 1.2 + v * 0.7 + u * 0.35) * 95) * 0.009
        const jade = clamp((mineral - 0.52) * 3.4) * 0.28
        const rose = clamp((0.48 - mineral) * 3.2) * 0.25
        const fire = clamp((fine - 0.62) * 3.5) * 0.22
        const curve = Math.sqrt(Math.max(0, 1 - ((u - 0.48) * 1.95) ** 2))
        const bevel = 0.56 + curve * 0.35
        const specular = Math.exp(-((u - 0.24 - (mineral - 0.5) * 0.1) ** 2) / 0.019) * 0.17
        const vertical = 0.95 + Math.sin(v * Math.PI) * 0.025
        for (let ch = 0; ch < 3; ch++) {
          const base = channels[ch]! * 0.38 + pearl[ch]! * 0.62
          const mineralColor =
            base * (1 - jade - rose - fire) +
            green[ch]! * jade +
            pink[ch]! * rose +
            gold[ch]! * fire
          pixels.data[index + ch] =
            mineralColor * bevel * vertical + pearl[ch]! * (specular + shell) + grain * 2.5
        }
      }
      pixels.data[index + 3] = coverage * 255
    }
  }
  ctx.putImageData(pixels, 0, 0)
  ctx.scale(2, 2)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(0.5, 0.5, 63, 191, silk ? 3.5 : 5)
  ctx.clip()
  if (silk) {
    // Fine aligned fibres show only close up. Their spacing and contrast stay
    // uniform so the material reads as woven satin rather than bundled wires.
    for (let i = 0; i < 44; i++) {
      const x = 3 + i * 1.32
      ctx.lineWidth = 0.16
      ctx.strokeStyle = 'rgba(232,247,229,0.022)'
      ctx.beginPath()
      ctx.moveTo(x, 1)
      ctx.bezierCurveTo(x + 1.2, 65, x + 1.4, 130, x - 0.5, 191)
      ctx.stroke()
    }
    // Soft bound edges, deliberately avoiding a glass-like rectangular rim.
    const cap = ctx.createLinearGradient(0, 0, 0, 10)
    cap.addColorStop(0, 'rgba(220,244,214,0.3)')
    cap.addColorStop(0.16, 'rgba(220,244,214,0.065)')
    cap.addColorStop(1, 'rgba(220,244,214,0)')
    ctx.fillStyle = cap
    ctx.fillRect(0, 0, 64, 10)
    ctx.fillStyle = 'rgba(221,240,207,0.21)'
    ctx.fillRect(5, 190, 54, 0.6)
  } else {
    // Porcelain-like carved edge with asymmetric top lighting, no neon rim.
    const rim = ctx.createLinearGradient(0, 0, 64, 30)
    rim.addColorStop(0, 'rgba(255,251,232,0.7)')
    rim.addColorStop(0.5, 'rgba(255,251,232,0.08)')
    rim.addColorStop(1, 'rgba(90,102,107,0.22)')
    ctx.strokeStyle = rim
    ctx.lineWidth = 0.9
    ctx.beginPath()
    ctx.roundRect(1, 1, 62, 190, 4.5)
    ctx.stroke()
    const cap = ctx.createLinearGradient(0, 185, 0, 192)
    cap.addColorStop(0, 'rgba(83,101,108,0)')
    cap.addColorStop(0.75, 'rgba(83,101,108,0.2)')
    cap.addColorStop(1, 'rgba(255,245,218,0.22)')
    ctx.fillStyle = cap
    ctx.fillRect(0, 185, 64, 7)
  }
  ctx.restore()
  return new Texture({ source: new CanvasSource({ resource: canvas, resolution: 2 }) })
}

function makeSilkVeil(fine: boolean): Texture {
  const [canvas, ctx] = makeCanvas(96, 320)
  const pixels = ctx.createImageData(96, 320)
  // Moving reflections are soft sheets of light, not another stack of fibres.
  // Slow independent motion gives the quiet satin surface a living lustre.
  for (let y = 0; y < 320; y++) {
    const v = y / 319
    const fade = Math.sin(v * Math.PI) ** 2.2
    const center = fine ? 0.62 - Math.sin(v * Math.PI) * 0.11 : 0.29 + v * 0.2
    for (let x = 0; x < 96; x++) {
      const u = x / 95
      const reflection = Math.exp(-((u - center) ** 2) / (fine ? 0.01 : 0.038))
      const index = (y * 96 + x) * 4
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = 255
      pixels.data[index + 3] = reflection * fade * (fine ? 150 : 165)
    }
  }
  ctx.putImageData(pixels, 0, 0)
  return Texture.from(canvas)
}

function makePearlVeil(fine: boolean): Texture {
  const [canvas, ctx] = makeCanvas(96, 192)
  // Elliptical subsurface patches. Their fades leave generous transparent
  // margins, so the moving lustre never changes the material's silhouette.
  for (let i = 0; i < (fine ? 3 : 5); i++) {
    ctx.save()
    ctx.translate(30 + Math.sin(i * 2.4) * 13 + (fine ? 18 : 0), 36 + i * 29)
    ctx.rotate(-0.4 + Math.sin(i * 3) * 0.4)
    ctx.scale(0.6, 1)
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 29)
    gradient.addColorStop(0, `rgba(255,255,255,${fine ? 0.72 : 0.78})`)
    gradient.addColorStop(0.4, `rgba(255,255,255,${fine ? 0.27 : 0.38})`)
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = gradient
    ctx.fillRect(-29, -29, 58, 58)
    ctx.restore()
  }
  return Texture.from(canvas)
}

function makeLight(): Texture {
  const [canvas, ctx] = makeCanvas(96, 96)
  const gradient = ctx.createRadialGradient(48, 48, 0, 48, 48, 48)
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)')
  gradient.addColorStop(0.18, 'rgba(255,255,255,0.4)')
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.08)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, 96, 96)
  return Texture.from(canvas)
}
