import { type Sprite, Texture } from 'pixi.js'

export type MaterialParticleStyle = 'silk' | 'gold' | 'pearl' | 'liquid' | 'mist'
export type MaterialParticleKind =
  | 'wisp'
  | 'fiber'
  | 'powder'
  | 'chip'
  | 'mineral'
  | 'pollen'
  | 'leaf'
  | 'spark'
  | 'contact'
  | 'glimmer'

interface Recipe {
  size: [number, number]
  life: [number, number]
  speed: number
}

export const MATERIAL_PARTICLES: Record<MaterialParticleKind, Recipe> = {
  wisp: { size: [35, 58], life: [1.6, 2.5], speed: 0.85 },
  fiber: { size: [3.5, 7.5], life: [0.9, 1.65], speed: 0.9 },
  powder: { size: [1.8, 3.8], life: [0.85, 1.8], speed: 1.1 },
  chip: { size: [1.5, 3.2], life: [0.8, 1.4], speed: 1.3 },
  mineral: { size: [1.8, 3.8], life: [0.95, 1.75], speed: 0.9 },
  pollen: { size: [1.9, 3.5], life: [0.8, 1.65], speed: 1.2 },
  leaf: { size: [4.5, 8], life: [1.2, 2.1], speed: 0.9 },
  spark: { size: [3.5, 6.5], life: [0.6, 1.1], speed: 1.85 },
  contact: { size: [35, 52], life: [0.58, 0.85], speed: 0 },
  glimmer: { size: [3.5, 6], life: [0.8, 1.4], speed: 0.85 },
}

// Fine matter has depth through alternating grain size, speed and lifetime,
// rather than big transparent bodies. Build the fixed recipes once, not per hit.
function repeatKinds(kinds: MaterialParticleKind[], count: number): MaterialParticleKind[] {
  return Array.from({ length: count }, () => kinds).flat()
}

export const MATERIAL_CHOREOGRAPHY: Record<
  MaterialParticleStyle,
  { onset: readonly MaterialParticleKind[]; sustain: readonly MaterialParticleKind[]; cap: number }
> = {
  mist: {
    onset: [
      'contact',
      ...repeatKinds(['wisp', 'powder', 'powder', 'powder', 'powder', 'powder', 'powder'], 4),
    ],
    sustain: ['wisp', 'powder', 'powder', 'powder'],
    cap: 384,
  },
  silk: {
    onset: ['contact', ...repeatKinds(['fiber', 'pollen', 'fiber', 'pollen'], 8)],
    sustain: ['fiber', 'pollen', 'fiber', 'pollen'],
    cap: 448,
  },

  gold: {
    onset: [
      'contact',
      'leaf',
      'spark',
      'spark',
      'leaf',
      'pollen',
      'glimmer',
      'leaf',
      'spark',
      'spark',
      'leaf',
      'pollen',
      'spark',
      'leaf',
      'spark',
      'glimmer',
      'leaf',
      'spark',
      'pollen',
      'spark',
      'leaf',
      'spark',
      'pollen',
      'spark',
    ],
    sustain: ['spark', 'pollen', 'spark'],
    cap: 480,
  },
  pearl: {
    onset: ['contact', ...repeatKinds(['mineral', 'pollen', 'mineral', 'pollen'], 8)],
    sustain: ['mineral', 'pollen', 'mineral', 'pollen'],
    cap: 448,
  },
  liquid: {
    onset: [
      'contact',
      ...repeatKinds(
        ['powder', 'chip', 'powder', 'powder', 'powder', 'powder', 'chip', 'powder', 'powder'],
        4,
      ),
    ],
    sustain: ['powder', 'powder', 'chip', 'powder', 'powder'],
    cap: 512,
  },
}

export function isMaterialParticleStyle(style: string): style is MaterialParticleStyle {
  return (
    style === 'silk' ||
    style === 'gold' ||
    style === 'pearl' ||
    style === 'liquid' ||
    style === 'mist'
  )
}

export interface MaterialParticle {
  sprite: Sprite
  x: number
  y: number
  originX: number
  originY: number
  vx: number
  vy: number
  age: number
  life: number
  size: number
  phase: number
  materialKind: MaterialParticleKind
}

// Material-coloured grains carry mostly neutral reflections. Gold's antique
// alloy palette is preserved independently of the three finer dust treatments.
export function materialParticleTint(
  style: MaterialParticleStyle,
  color: number,
  kind?: MaterialParticleKind,
): number {
  // Mist stays in its own amber/rose lighting even over a purple track.
  if (style === 'mist') return kind === 'wisp' ? 0xe8b4a0 : kind === 'contact' ? 0xffbf83 : 0xffd891
  const highlight =
    style === 'gold'
      ? kind === 'contact' || kind === 'spark'
        ? 0xffc16a
        : 0xffe2a0
      : style === 'pearl'
        ? 0xfff4e6
        : 0xf4fcff
  const amount =
    style === 'gold'
      ? 0.94
      : style === 'liquid'
        ? kind === 'chip'
          ? 0.92
          : 0.76
        : style === 'pearl'
          ? 0.8
          : 0.42
  const channel = (shift: number) =>
    Math.round(((color >> shift) & 255) * (1 - amount) + ((highlight >> shift) & 255) * amount)
  return (channel(16) << 16) | (channel(8) << 8) | channel(0)
}

export function updateMaterialParticle(p: MaterialParticle, style: MaterialParticleStyle): void {
  const t = p.age
  const u = t / p.life
  const kind = p.materialKind
  const envelope =
    kind === 'fiber' || kind === 'leaf' || kind === 'glimmer' || kind === 'pollen'
      ? Math.sin(Math.PI * u)
      : 0
  const travel =
    kind === 'contact'
      ? 0
      : (style === 'silk' ? 96 : style === 'gold' ? 92 : 85) * (1 - Math.exp(-t / 0.85))
  const size = p.size / 32
  const s = p.sprite
  // Powder and contact light provide their own position below; sampling the
  // generic breeze here would compute and immediately overwrite it.
  if (kind !== 'powder' && kind !== 'contact' && kind !== 'wisp') {
    const sway = (Math.sin(p.phase + t * 1.6) - Math.sin(p.phase)) * (style === 'silk' ? 10 : 5)
    p.x = p.originX + p.vx * travel + sway * u
    p.y = p.originY + p.vy * travel
    s.position.set(p.x, p.y)
  }
  s.rotation = 0

  switch (p.materialKind) {
    case 'wisp': {
      // Every plume shares one rightward updraft. Small phase differences
      // open its curls gradually; mirrored texture grains avoid repeated blobs.
      const drift = 58 * (1 - Math.exp(-t / 1.1))
      const curl = (Math.sin(p.phase * 0.18 + t * 1.1) - Math.sin(p.phase * 0.18)) * 12
      s.position.set(
        p.originX + drift + Math.abs(p.vx) * travel * 0.38 + curl,
        p.originY + p.vy * 126 * (1 - Math.exp(-t / 1.05)) - t * 12 - p.size * 0.22,
      )
      s.rotation = -0.4 + Math.sin(p.phase + t * 0.65) * 0.32
      const mirror = Math.sin(p.phase) < 0 ? -1 : 1
      s.scale.set(size * (0.65 + u * 0.65) * mirror, size * (0.9 + u * 0.9))
      s.alpha = Math.min(1, t / 0.12) * (1 - u) ** 1.4 * 0.38
      break
    }
    case 'fiber': {
      // A short satin thread bends with one coherent breeze. No giant curves,
      // flames or continuously stretching ribbons.
      const drift = (1 - Math.exp(-t * 1.8)) * 6
      s.position.x += drift
      s.rotation = p.vx * 0.4 + 0.22 + Math.sin(p.phase * 0.25 + t * 1.2) * 0.14
      s.scale.set(size * (0.8 + 0.2 * Math.cos(p.phase + t)), size * (0.88 + 0.12 * envelope))
      s.alpha = Math.min(1, t / 0.055) * (1 - u) ** 0.85 * (0.62 + 0.3 * Math.cos(p.phase + t) ** 2)
      break
    }
    case 'powder': {
      // Small grains hang behind the faster foreground powder. A shared
      // breeze gives the cloud one direction while preserving its depth.
      const depth = Math.min(1, Math.max(0, (p.size - 1.8) / 2))
      const drift = (style === 'mist' ? 23 : 4) * (1 - Math.exp(-t * 1.6))
      const grainTravel = travel * (0.64 + depth * 0.4)
      const horizontal = style === 'mist' ? Math.abs(p.vx) * 0.55 + 0.18 : p.vx
      s.position.set(
        p.originX + horizontal * grainTravel + drift,
        p.originY + p.vy * grainTravel - t * 2,
      )
      const glint = Math.abs(Math.sin(p.phase + t * 1.9)) ** 10
      s.rotation = p.phase
      s.scale.set(size * (0.95 - u * 0.15))
      s.alpha = Math.min(1, t / 0.025) * (1 - u) ** 0.75 * (0.36 + depth * 0.16 + glint * 0.48)
      break
    }
    case 'chip': {
      const face = Math.abs(Math.cos(p.phase + t * 2.2))
      s.rotation = p.phase + t * 0.7
      s.scale.set(size * (0.35 + face * 0.65), size)
      // A narrow silver flash is earned as a tiny plane catches the light.
      s.alpha = Math.min(1, t / 0.035) * (1 - u) ** 0.8 * (0.24 + face ** 18 * 0.76)
      s.position.x += 2 * (1 - Math.exp(-t * 1.6))
      s.position.y += t * t * 4
      break
    }
    case 'mineral': {
      const face = Math.abs(Math.sin(p.phase + t * 1.6))
      s.rotation = p.phase + t * 0.6
      s.scale.set(size * (0.45 + face * 0.55), size * (0.85 + face * 0.15))
      s.alpha = Math.min(1, t / 0.07) * (1 - u) ** 0.8 * (0.4 + face ** 4 * 0.55)
      s.position.y += t * t * 3
      break
    }
    case 'spark':
      s.rotation = Math.atan2(p.vy + t * 0.18, p.vx) + Math.PI / 2
      s.scale.set(size * 0.35, size * (1.7 - u))
      s.alpha = Math.min(1, t / 0.025) * (1 - u) ** 1.3
      s.position.y += t * t * 10
      break
    case 'contact':
      s.position.set(p.originX, p.originY - 2)
      s.scale.set(
        size * (0.8 + u * 0.7),
        size * (style === 'gold' ? 0.13 + u * 0.17 : 0.07 + u * 0.08),
      )
      s.alpha = Math.min(1, t / 0.03) * (1 - u) ** 2 * (style === 'gold' ? 0.78 : 0.25)
      break
    case 'leaf': {
      const angle = p.phase + t * 1.65
      const face = Math.abs(Math.cos(angle))
      s.rotation = p.phase * 0.4 + t * 0.85
      s.scale.set(size * (0.12 + 0.88 * face), size)
      // Broad soft reflections interrupted by a brief specular glint when
      // the foil faces the light. No binary flashing or uniform confetti.
      s.alpha = envelope * (0.32 + face * 0.3 + face ** 18 * 0.38)
      s.position.y += t * t * 4
      break
    }
    case 'glimmer': {
      const glint = 0.12 + 0.88 * Math.abs(Math.cos(p.phase + u * 2.7)) ** 12
      s.scale.set(size * (0.7 + glint * 0.3))
      s.rotation = p.phase + t * 0.12
      s.alpha = envelope * glint * 0.8
      break
    }
    case 'pollen':
      s.scale.set(size * (1 - u * 0.25))
      s.alpha = envelope * (0.48 + 0.15 * Math.sin(p.phase + u * 3))
      break
  }
}

// Cache only a selected style's textures. Shared grain kinds are reused when
// switching styles; hidden material families need no canvases or GPU sources.
export function buildMaterialParticleTextures(
  style: MaterialParticleStyle,
  textures: Partial<Record<MaterialParticleKind, Texture>>,
): void {
  const recipe = MATERIAL_CHOREOGRAPHY[style]
  for (const sequence of [recipe.onset, recipe.sustain]) {
    for (const kind of sequence) {
      if (!textures[kind]) textures[kind] = buildTexture(kind)
    }
  }
}

function buildTexture(kind: MaterialParticleKind): Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const c = canvas.getContext('2d')!
  if (kind === 'wisp') {
    // Overlapping translucent brush deposits describe a tapered curl. The
    // ridges remain soft, but keep enough structure to read against lit notes.
    const brush = (x: number, y: number, radius: number, opacity: number) => {
      const cloud = c.createRadialGradient(x, y, 0, x, y, radius)
      cloud.addColorStop(0, `rgba(255,246,239,${opacity})`)
      cloud.addColorStop(0.25, `rgba(255,237,227,${opacity * 0.72})`)
      cloud.addColorStop(0.65, `rgba(236,220,226,${opacity * 0.2})`)
      cloud.addColorStop(1, 'rgba(255,255,255,0)')
      c.fillStyle = cloud
      c.fillRect(0, 0, 64, 64)
    }
    for (let i = 0; i <= 24; i++) {
      const u = i / 24
      const fade = Math.sin(Math.PI * u) ** 0.65
      const x = 15 + u * 30 + Math.sin(u * Math.PI * 2) * 12
      const y = 59 - u * 53
      brush(x, y, 5 + fade * 5, 0.105 * fade)
      brush(x + 6 - u * 3, y - 1, 3 + fade * 3, 0.052 * fade)
    }
    for (let i = 0; i <= 17; i++) {
      const u = i / 17
      const angle = Math.PI * (0.12 + u * 1.5)
      brush(
        36 + Math.cos(angle) * 14,
        24 + Math.sin(angle) * 12,
        3.5 + u * 2.5,
        Math.sin(Math.PI * u) * 0.075,
      )
    }
  } else if (kind === 'fiber') {
    const sheen = c.createLinearGradient(0, 8, 0, 56)
    sheen.addColorStop(0, 'rgba(255,255,255,0)')
    sheen.addColorStop(0.23, 'rgba(239,255,252,0.55)')
    sheen.addColorStop(0.44, 'rgba(255,255,255,1)')
    sheen.addColorStop(0.7, 'rgba(231,251,248,0.6)')
    sheen.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = sheen
    c.beginPath()
    c.moveTo(31, 7)
    c.bezierCurveTo(26, 23, 32, 37, 35, 57)
    c.bezierCurveTo(28, 42, 26, 27, 31, 7)
    c.fill()
    c.strokeStyle = sheen
    c.lineWidth = 1.2
    c.beginPath()
    c.moveTo(35, 13)
    c.bezierCurveTo(32, 27, 35, 40, 38, 51)
    c.stroke()
  } else if (kind === 'powder') {
    const light = c.createRadialGradient(32, 32, 0, 32, 32, 15)
    light.addColorStop(0, 'rgba(255,255,255,1)')
    light.addColorStop(0.32, 'rgba(255,255,255,0.95)')
    light.addColorStop(0.55, 'rgba(240,251,255,0.3)')
    light.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = light
    c.fillRect(16, 16, 32, 32)
    c.fillStyle = 'rgba(255,255,255,0.9)'
    c.fillRect(29, 29, 5, 6)
  } else if (kind === 'chip' || kind === 'mineral') {
    const mineral = kind === 'mineral'
    const face = c.createLinearGradient(19, 16, 45, 48)
    face.addColorStop(0, mineral ? 'rgba(232,211,255,0.86)' : 'rgba(245,254,255,0.9)')
    face.addColorStop(0.44, mineral ? 'rgba(240,231,215,0.7)' : 'rgba(235,250,255,0.22)')
    face.addColorStop(0.53, mineral ? 'rgba(197,242,225,0.8)' : 'rgba(255,255,255,0.85)')
    face.addColorStop(1, mineral ? 'rgba(248,203,217,0.65)' : 'rgba(226,244,255,0.2)')
    c.fillStyle = face
    c.beginPath()
    c.moveTo(24, 13)
    c.lineTo(43, 22)
    c.lineTo(mineral ? 48 : 39, 36)
    c.lineTo(27, 49)
    c.lineTo(19, 34)
    c.closePath()
    c.fill()
    c.strokeStyle = 'rgba(255,255,255,0.95)'
    c.lineWidth = mineral ? 1.3 : 2
    c.beginPath()
    c.moveTo(24, 13)
    c.lineTo(31, 30)
    c.lineTo(27, 49)
    c.stroke()
  } else if (kind === 'spark') {
    const light = c.createLinearGradient(0, 4, 0, 62)
    light.addColorStop(0, 'rgba(255,255,255,0)')
    light.addColorStop(0.22, 'rgba(255,255,255,1)')
    light.addColorStop(0.42, 'rgba(255,255,255,0.8)')
    light.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = light
    c.fillRect(29.5, 2, 5, 60)
    c.fillRect(31, 2, 2, 56)
  } else if (kind === 'contact') {
    const light = c.createRadialGradient(32, 32, 0, 32, 32, 31)
    light.addColorStop(0, 'rgba(255,255,255,1)')
    light.addColorStop(0.1, 'rgba(255,255,255,0.8)')
    light.addColorStop(0.33, 'rgba(255,255,255,0.3)')
    light.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = light
    c.fillRect(0, 0, 64, 64)
  } else if (kind === 'leaf') {
    const foil = c.createLinearGradient(19, 9, 45, 53)
    foil.addColorStop(0, 'rgba(255,255,255,0.35)')
    foil.addColorStop(0.42, 'rgba(255,255,255,0.7)')
    foil.addColorStop(0.48, 'rgba(255,255,255,0.2)')
    foil.addColorStop(0.56, 'rgba(255,255,255,0.8)')
    foil.addColorStop(1, 'rgba(255,255,255,0.25)')
    c.fillStyle = foil
    c.beginPath()
    c.moveTo(23, 10)
    c.lineTo(44, 19)
    c.lineTo(40, 31)
    c.lineTo(45, 47)
    c.lineTo(28, 54)
    c.lineTo(18, 39)
    c.lineTo(22, 25)
    c.closePath()
    c.fill()
    c.lineWidth = 0.8
    c.strokeStyle = 'rgba(255,255,255,0.68)'
    c.stroke()
    c.beginPath()
    c.moveTo(23, 10)
    c.lineTo(32, 31)
    c.lineTo(28, 54)
    c.stroke()
  } else {
    const light = c.createRadialGradient(32, 32, 0, 32, 32, 31)
    light.addColorStop(0, kind === 'glimmer' ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,1)')
    light.addColorStop(kind === 'pollen' ? 0.15 : 0.32, 'rgba(255,255,255,0.18)')
    light.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = light
    c.fillRect(0, 0, 64, 64)
    if (kind === 'glimmer') {
      c.strokeStyle = 'rgba(255,255,255,0.95)'
      c.lineWidth = 1.2
      c.beginPath()
      c.moveTo(32, 10)
      c.lineTo(32, 54)
      c.moveTo(21, 32)
      c.lineTo(43, 32)
      c.stroke()
    }
  }
  return Texture.from(canvas)
}
