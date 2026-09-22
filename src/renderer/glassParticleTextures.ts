import { Texture } from 'pixi.js'

export type GlassParticleKind = 'facet' | 'glint' | 'dust' | 'ribbon' | 'haze'

// A layered onset: low contact haze, long refraction trails, tumbling
// facets and a finer scatter of pinpoints. Each family has its own lifetime.
export const GLASS_BURST: readonly GlassParticleKind[] = [
  'haze',
  'ribbon',
  'ribbon',
  'facet',
  'dust',
  'glint',
  'dust',
  'facet',
  'dust',
  'glint',
  'facet',
  'dust',
  'glint',
  'facet',
  'dust',
  'dust',
  'ribbon',
  'facet',
  'dust',
  'facet',
  'ribbon',
  'dust',
  'facet',
  'dust',
  'glint',
  'haze',
]

export const GLASS_PARTICLES: Record<
  GlassParticleKind,
  {
    size: [number, number]
    life: [number, number]
    speed: number
  }
> = {
  facet: { size: [5, 9.5], life: [1.05, 1.7], speed: 1.15 },
  glint: { size: [4, 9], life: [0.8, 1.35], speed: 0.7 },
  dust: { size: [1.6, 3], life: [0.85, 1.6], speed: 1.35 },
  ribbon: { size: [28, 43], life: [0.7, 1.05], speed: 1.2 },
  haze: { size: [32, 48], life: [1.1, 1.65], speed: 0.2 },
}

export function buildGlassParticleTextures(): Record<GlassParticleKind, Texture> {
  return {
    facet: texture('facet'),
    glint: texture('glint'),
    dust: texture('dust'),
    ribbon: texture('ribbon'),
    haze: texture('haze'),
  }
}

function texture(kind: GlassParticleKind): Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')!
  if (kind === 'haze' || kind === 'dust' || kind === 'glint') {
    const light = ctx.createRadialGradient(32, 32, 0, 32, 32, 31)
    light.addColorStop(0, `rgba(255,255,255,${kind === 'glint' ? 0.35 : 1})`)
    light.addColorStop(kind === 'dust' ? 0.12 : 0.3, 'rgba(255,255,255,0.2)')
    light.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = light
    ctx.fillRect(0, 0, 64, 64)
  }

  if (kind === 'facet') {
    // Two planes and a bright fractured edge: the rotating sprite reads as a
    // sliver of polished glass rather than a solid white diamond / confetti.
    const plane = ctx.createLinearGradient(18, 12, 44, 50)
    plane.addColorStop(0, 'rgba(240,249,255,0.6)')
    plane.addColorStop(0.43, 'rgba(240,249,255,0.1)')
    plane.addColorStop(1, 'rgba(240,249,255,0.32)')
    ctx.fillStyle = plane
    ctx.beginPath()
    ctx.moveTo(27, 8)
    ctx.lineTo(44, 20)
    ctx.lineTo(38, 49)
    ctx.lineTo(23, 55)
    ctx.lineTo(18, 28)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = 'rgba(245,252,255,0.85)'
    ctx.lineWidth = 1.1
    ctx.stroke()
    ctx.fillStyle = 'rgba(245,252,255,0.28)'
    ctx.beginPath()
    ctx.moveTo(27, 8)
    ctx.lineTo(32, 32)
    ctx.lineTo(23, 55)
    ctx.lineTo(18, 28)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = 1.4
    ctx.beginPath()
    ctx.moveTo(27, 8)
    ctx.lineTo(32, 32)
    ctx.lineTo(38, 49)
    ctx.stroke()
  } else if (kind === 'glint') {
    ctx.fillStyle = 'rgba(241,251,255,0.95)'
    ctx.beginPath()
    ctx.moveTo(32, 5)
    ctx.lineTo(34, 29)
    ctx.lineTo(49, 32)
    ctx.lineTo(34, 34)
    ctx.lineTo(32, 59)
    ctx.lineTo(30, 35)
    ctx.lineTo(15, 32)
    ctx.lineTo(30, 30)
    ctx.closePath()
    ctx.fill()
  } else if (kind === 'ribbon') {
    const trail = ctx.createLinearGradient(0, 5, 0, 62)
    trail.addColorStop(0, 'rgba(255,255,255,0)')
    trail.addColorStop(0.13, 'rgba(255,255,255,0.95)')
    trail.addColorStop(0.4, 'rgba(255,255,255,0.35)')
    trail.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.strokeStyle = trail
    for (let i = 0; i < 2; i++) {
      ctx.lineWidth = i ? 0.55 : 1.25
      ctx.beginPath()
      ctx.moveTo(29 + i * 3, 4)
      ctx.bezierCurveTo(14 + i * 2, 22, 47 + i * 2, 40, 29 + i * 4, 63)
      ctx.stroke()
    }
  }
  return Texture.from(c)
}
