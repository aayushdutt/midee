import { Container, Sprite, Texture } from 'pixi.js'
import {
  buildGlassParticleTextures,
  GLASS_BURST,
  GLASS_PARTICLES,
  type GlassParticleKind,
} from './glassParticleTextures'

import {
  buildMaterialParticleTextures,
  isMaterialParticleStyle,
  MATERIAL_CHOREOGRAPHY,
  MATERIAL_PARTICLES,
  type MaterialParticleKind,
  type MaterialParticleStyle,
  materialParticleTint,
  updateMaterialParticle,
} from './materialParticles'

import type { ParticleStyle } from './particleStyles'

// Compatibility for renderer consumers; menus and persistence use the light catalog.
export { PARTICLE_STYLES, type ParticleStyle, type ParticleStyleInfo } from './particleStyles'

interface StyleConfig {
  count: number // particles per burst
  sustainCount: number // particles per sustained tick (held note)
  speedMin: number // initial speed (px/frame at 60fps)
  speedMax: number
  lifeMin: number // seconds
  lifeMax: number
  sizeMin: number // final sprite scale × radial-texture radius in px
  sizeMax: number
  gravity: number // per-frame additive vy
  drag: number // per-frame velocity damping (0..1)
  upwardArc: number // fraction of π — cone width
  windStrength: number // px/sec of constant-direction drift
  windFlutter: number // ±amplitude variation (0..1)
  turbulence: number // per-style multiplier for micro sway (1 = normal)
  alphaScale: number // overall brightness multiplier (1 = full)
  fadeCurve: 'ease-out' | 'bell' | 'twinkle' | 'swell' | 'flash'
  hueJitter: number // ±degrees (tight → cohesive palette)
  valueJitter: number // ±lightness (0..1)
  blend: 'normal' | 'add'
}

// Speeds are in px/frame applied to `p.vx/p.vy`. Wind is force per second
// (multiplied by dt before accumulating into velocity). Everything is dialled
// down roughly 2× from the previous pass — particles should float, not fly.
const STYLES: Record<ParticleStyle, StyleConfig> = {
  silk: materialConfig('silk'),
  gold: materialConfig('gold'),
  pearl: materialConfig('pearl'),
  liquid: materialConfig('liquid'),
  mist: materialConfig('mist'),
  glass: {
    count: GLASS_BURST.length,
    sustainCount: 2,
    speedMin: 0.65,
    speedMax: 1.6,
    lifeMin: 0.65,
    lifeMax: 1.35,
    sizeMin: 3,
    sizeMax: 6.5,
    gravity: 0,
    drag: 0,
    upwardArc: 0.65,
    windStrength: 0,
    windFlutter: 0,
    turbulence: 0,
    alphaScale: 0.72,
    fadeCurve: 'bell',
    hueJitter: 2,
    valueJitter: 0.025,
    blend: 'add',
  },
  sparks: {
    count: 14,
    sustainCount: 2,
    speedMin: 0.9,
    speedMax: 2.6,
    lifeMin: 0.45,
    lifeMax: 0.9,
    sizeMin: 1.6,
    sizeMax: 3.8,
    gravity: 0.04,
    drag: 0.01,
    upwardArc: 0.75,
    windStrength: 1.2,
    windFlutter: 0.15,
    turbulence: 1,
    alphaScale: 1,
    fadeCurve: 'ease-out',
    hueJitter: 3,
    valueJitter: 0.05,
    blend: 'add',
  },
  embers: {
    count: 18,
    sustainCount: 2,
    speedMin: 0.4,
    speedMax: 1.3,
    lifeMin: 1.2,
    lifeMax: 2.4,
    sizeMin: 1.3,
    sizeMax: 3.0,
    gravity: -0.015,
    drag: 0.02,
    upwardArc: 0.45,
    windStrength: 2.5,
    windFlutter: 0.2,
    turbulence: 1.2,
    alphaScale: 1,
    fadeCurve: 'twinkle',
    hueJitter: 5,
    valueJitter: 0.08,
    blend: 'add',
  },
  // Bloom: a few soft motes drifting upward, then gone. Tuned down from the
  // original "dreamy" preset — old life range (2.4–4.0s) made bursts linger
  // past their welcome; now each mote lives just long enough to register
  // without polluting the roll with persistent glow.
  bloom: {
    count: 4,
    sustainCount: 1,
    speedMin: 0.12,
    speedMax: 0.45,
    lifeMin: 1.0,
    lifeMax: 1.7,
    sizeMin: 6,
    sizeMax: 12,
    gravity: -0.008,
    drag: 0.08,
    upwardArc: 0.65,
    windStrength: 0.9,
    windFlutter: 0.2,
    turbulence: 2.4,
    alphaScale: 0.32,
    fadeCurve: 'swell',
    hueJitter: 3,
    valueJitter: 0.05,
    blend: 'add',
  },
  // Sparkle: crisp, glinty, with real character — deep pulse, varied rate.
  sparkle: {
    count: 16,
    sustainCount: 2,
    speedMin: 0.1,
    speedMax: 0.85,
    lifeMin: 0.8,
    lifeMax: 1.8,
    sizeMin: 1.0,
    sizeMax: 4.2,
    gravity: -0.005,
    drag: 0.07,
    upwardArc: 0.9,
    windStrength: 0.8,
    windFlutter: 0.35,
    turbulence: 1.5,
    alphaScale: 1,
    fadeCurve: 'flash',
    hueJitter: 8,
    valueJitter: 0.14,
    blend: 'add',
  },
  // 'Off' preset — burst() early-outs before consuming from the pool.
  none: {
    count: 0,
    sustainCount: 0,
    speedMin: 0,
    speedMax: 0,
    lifeMin: 0,
    lifeMax: 0,
    sizeMin: 0,
    sizeMax: 0,
    gravity: 0,
    drag: 0,
    upwardArc: 0,
    windStrength: 0,
    windFlutter: 0,
    turbulence: 0,
    alphaScale: 0,
    fadeCurve: 'ease-out',
    hueJitter: 0,
    valueJitter: 0,
    blend: 'add',
  },
}

function materialConfig(style: MaterialParticleStyle): StyleConfig {
  const recipe = MATERIAL_CHOREOGRAPHY[style]
  return {
    count: recipe.onset.length,
    sustainCount: recipe.sustain.length,
    speedMin: style === 'liquid' ? 0.8 : 0.7,
    speedMax: style === 'liquid' ? 1.6 : 1.65,
    lifeMin: 1,
    lifeMax: 2,
    sizeMin: 2,
    sizeMax: 6,
    gravity: 0,
    drag: 0,
    upwardArc:
      style === 'mist'
        ? 0.3
        : style === 'silk'
          ? 0.28
          : style === 'pearl'
            ? 0.44
            : style === 'liquid'
              ? 0.52
              : 0.55,
    windStrength: 0,
    windFlutter: 0,
    turbulence: 0,
    alphaScale: 1,
    fadeCurve: 'bell',
    hueJitter: 0,
    valueJitter: 0.015,
    blend: 'add',
  }
}

interface Particle {
  sprite: Sprite
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
  size: number
  phase: number
  // Per-particle wind sensitivity (0.55–1.45). Gives the burst a natural
  // spread: lighter particles drift further, heavier ones barely move —
  // exactly how real wind looks when it catches a dust cloud.
  windFactor: number
  // Per-particle tiny x-jitter amplitude for micro-turbulence.
  turbAmp: number
  originX: number
  originY: number
  glassKind: GlassParticleKind
  materialKind: MaterialParticleKind
}

const POOL_SIZE = 1024
const TEXTURE_RESOLUTION = 64

export class ParticleSystem {
  readonly container: Container

  private pool: Particle[] = []
  private active: Particle[] = []

  // True while any particle is mid-flight. The renderer's idle detector keeps
  // the ticker alive until the last burst decays, then stops rendering.
  get hasActive(): boolean {
    return this.active.length > 0
  }
  private texture: Texture | null = null
  private glassTextures: Record<GlassParticleKind, Texture> | null = null
  private materialTextures: Partial<Record<MaterialParticleKind, Texture>> = {}
  private emissionSerial = 0
  private style: ParticleStyle = 'sparks'
  // Wind always blows to the right — a gentle consistent breeze. Kept as a
  // field for future theming (leftward/rightward per theme) without churn.
  private windDirection = 1
  private clock = 0

  constructor() {
    this.container = new Container()
    this.container.label = 'particles'
    this.container.blendMode = 'add'
    this.texture = buildRadialTexture()

    for (let i = 0; i < POOL_SIZE; i++) {
      const sprite = new Sprite(this.texture)
      sprite.anchor.set(0.5)
      sprite.visible = false
      this.container.addChild(sprite)
      this.pool.push({
        sprite,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        age: 0,
        life: 1,
        size: 1,
        phase: 0,
        windFactor: 1,
        turbAmp: 0,
        originX: 0,
        originY: 0,
        glassKind: 'glint',
        materialKind: 'pollen',
      })
    }
  }

  setStyle(style: ParticleStyle): void {
    if (this.style === style) return
    this.clear()
    this.style = style
    if (style === 'glass' && !this.glassTextures) this.glassTextures = buildGlassParticleTextures()
    if (isMaterialParticleStyle(style)) buildMaterialParticleTextures(style, this.materialTextures)
    this.container.blendMode = STYLES[style].blend === 'add' ? 'add' : 'normal'
    // Switching to Off is meant to feel immediate — clear any motes mid-flight.
    if (style === 'none') this.clear()
  }

  // `x,y` = centre of the key's top edge. `keyWidth` = key width in px — used
  // to spread emission across the whole key so particles don't pinch out of a
  // single point. `count` overrides the style's default burst size — useful for
  // sustained note emission where each tick adds only a few particles.
  // Sustained-emission convenience — picks the per-style sustain count so
  // callers don't have to reach into config. Respects 'none' via the same
  // zero-count path as `burst`.
  sustainBurst(x: number, y: number, color: number, keyWidth = 20): void {
    const cfg = STYLES[this.style]
    if (cfg.sustainCount > 0) this.burst(x, y, color, keyWidth, cfg.sustainCount)
  }

  burst(x: number, y: number, color: number, keyWidth = 20, count?: number): void {
    const cfg = STYLES[this.style]
    const emitCount = count ?? cfg.count
    if (emitCount <= 0 || this.style === 'none') return
    const material = isMaterialParticleStyle(this.style) ? this.style : null
    const choreography = material ? MATERIAL_CHOREOGRAPHY[material] : null
    const glass = this.style === 'glass'
    // Repeatable glints for export; clear() starts a fresh take.
    const random =
      glass || material
        ? seededRandom(Math.round(x * 17) + this.emissionSerial++ * 7919)
        : Math.random

    // Per-burst (per-key) personality. Derived deterministically from x so
    // each key always looks the same, but different keys differ from each
    // other. Two hash-ish sin waves give us two uncorrelated numbers in
    // [0, 1] for essentially zero cost.
    const keyBias = 0.5 + 0.5 * Math.sin(x * 0.093)
    const keyTurbBias = 0.5 + 0.5 * Math.sin(x * 0.137 + 1.1)
    const keyPhase = x * 0.021
    const windKeyMul = 0.82 + keyBias * 0.36 // 0.82..1.18
    const turbKeyMul = 0.75 + keyTurbBias * 0.5 // 0.75..1.25
    const arcKeyMul = 0.9 + keyBias * 0.2 // 0.90..1.10

    // Half-width of the emission line (80% of key width — avoids spawning
    // right on the key edges where neighbouring notes' particles would
    // overlap confusingly).
    const emissionHalf = keyWidth * 0.4

    for (let i = 0; i < emitCount; i++) {
      if (this.active.length >= (choreography?.cap ?? (glass ? 448 : POOL_SIZE))) break
      const p = this.pool.pop()
      if (!p) break

      // Center-biased triangular distribution in [-1, 1]. Sum of two uniforms
      // is a natural plume density — more particles from the middle of the
      // key, tapering to the edges. One extra random() per particle.
      const u = random() + random() - 1
      const spawnOffset = u * emissionHalf
      // Plume fan: particles from the left edge lean slightly left, from the
      // right edge slightly right. Combined with the random upward arc this
      // produces a naturally spreading column rather than a starburst.
      const positionTilt = u * 0.32 // max ±0.32 rad = ±18°
      const angle =
        -Math.PI / 2 +
        (material === 'mist' ? 0.2 : 0) +
        (random() - 0.5) * Math.PI * cfg.upwardArc * arcKeyMul +
        positionTilt
      const speed = cfg.speedMin + random() * (cfg.speedMax - cfg.speedMin)

      p.x = x + spawnOffset
      p.y = y
      p.originX = p.x
      p.originY = y
      p.vx = Math.cos(angle) * speed
      p.vy = Math.sin(angle) * speed
      p.age = 0
      p.life = cfg.lifeMin + random() * (cfg.lifeMax - cfg.lifeMin)
      p.size = cfg.sizeMin + random() * (cfg.sizeMax - cfg.sizeMin)
      // Burst-coherent phase + particle-unique offset. Particles from one
      // key move together; particles from a different key move a bit apart.
      p.phase = keyPhase + random() * 0.8
      // Wind factor = burst bias × per-particle spread. Narrower spread
      // within a burst keeps the key's "fingerprint" legible.
      p.windFactor = windKeyMul * (0.7 + random() * 0.6)
      p.turbAmp = turbKeyMul * cfg.turbulence * (0.06 + random() * 0.16)

      if (glass) {
        // Sustains shed only fine detail. The haze and ribbons belong to the
        // onset, so a held chord never accumulates a continuous smoke curtain.
        p.glassKind =
          count === undefined
            ? GLASS_BURST[i % GLASS_BURST.length]!
            : random() < 0.7
              ? 'dust'
              : 'glint'
        const recipe = GLASS_PARTICLES[p.glassKind]
        p.life = recipe.life[0] + random() * (recipe.life[1] - recipe.life[0])
        p.size = recipe.size[0] + random() * (recipe.size[1] - recipe.size[0])
        p.vx *= recipe.speed
        p.vy *= recipe.speed
        // Unique tumbling phases within a coherent burst.
        p.phase += random() * Math.PI * 2
      }

      if (choreography) {
        const sequence = count === undefined ? choreography.onset : choreography.sustain
        p.materialKind = sequence[i % sequence.length]!
        const recipe = MATERIAL_PARTICLES[p.materialKind]
        p.life = recipe.life[0] + random() * (recipe.life[1] - recipe.life[0])
        p.size = recipe.size[0] + random() * (recipe.size[1] - recipe.size[0])
        p.vx *= recipe.speed
        p.vy *= recipe.speed
        p.phase += random() * Math.PI * 2
        if (p.materialKind === 'contact') {
          p.x = p.originX = x
          p.size = Math.min(55, Math.max(32, keyWidth * 1.8))
        }
      }

      const sprite = p.sprite
      sprite.texture = material
        ? this.materialTextures[p.materialKind]!
        : glass
          ? this.glassTextures![p.glassKind]
          : this.texture!
      sprite.rotation = glass ? p.phase : 0
      sprite.scale.set(p.size / (TEXTURE_RESOLUTION * 0.5))
      sprite.position.set(p.x, p.y)
      sprite.tint = jitterColor(
        material
          ? materialParticleTint(material, color, p.materialKind)
          : glass
            ? silverTint(color)
            : color,
        cfg.hueJitter,
        cfg.valueJitter,
        random,
      )
      sprite.visible = true
      sprite.alpha = glass || material ? 0 : 1
      this.active.push(p)
    }
  }

  update(dt: number): void {
    // A preview / theme repaint must not move particles.
    if (dt <= 0) return
    this.clock += dt
    if (this.active.length === 0) return
    const glass = this.style === 'glass'
    const material = isMaterialParticleStyle(this.style) ? this.style : null
    const cfg = STYLES[this.style]

    // Global wind: constant direction, never reverses. A gentle amplitude
    // flutter (slow sin) makes gusts feel natural without introducing chaos.
    const flutter = 1 - cfg.windFlutter + cfg.windFlutter * (0.5 + 0.5 * Math.sin(this.clock * 0.6))
    const windForce = this.windDirection * cfg.windStrength * flutter
    const clock = this.clock

    let i = this.active.length
    while (i--) {
      const p = this.active[i]!
      p.age += dt
      if (p.age >= p.life) {
        p.sprite.visible = false
        this.active[i] = this.active[this.active.length - 1]!
        this.active.pop()
        this.pool.push(p)
        continue
      }

      if (glass) {
        updateGlassParticle(p)
        continue
      }

      if (material) {
        updateMaterialParticle(p, material)
        continue
      }

      // Per-particle wind response: windFactor scales the global force.
      // A tiny sinusoidal turbulence jiggles each particle at its own phase —
      // cheap, deterministic, and "organic-enough" without noise sampling.
      const turbulence = Math.sin(clock * 2.1 + p.phase) * p.turbAmp
      p.vx += (windForce * p.windFactor + turbulence) * dt
      p.vy += cfg.gravity
      if (cfg.drag > 0) {
        p.vx *= 1 - cfg.drag
        p.vy *= 1 - cfg.drag
      }
      p.x += p.vx
      p.y += p.vy

      const u = p.age / p.life
      const alpha = alphaAt(cfg.fadeCurve, u, p.phase, clock) * cfg.alphaScale
      const scale = (p.size * sizeFactorAt(cfg.fadeCurve, u)) / (TEXTURE_RESOLUTION * 0.5)

      const s = p.sprite
      s.position.set(p.x, p.y)
      s.alpha = alpha
      s.scale.set(scale)
    }
  }

  clear(): void {
    for (const p of this.active) {
      p.sprite.visible = false
      this.pool.push(p)
    }
    this.active.length = 0
    this.clock = 0
    this.emissionSerial = 0
  }

  destroy(): void {
    this.clear()
    this.container.destroy({ children: true })
    this.texture?.destroy(true)
    if (this.glassTextures)
      for (const texture of Object.values(this.glassTextures)) texture.destroy(true)
    for (const texture of Object.values(this.materialTextures)) texture.destroy(true)
    this.pool = []
  }
}

function seededRandom(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0
    return (state >>> 0) / 4294967296
  }
}

function silverTint(color: number): number {
  const r = Math.round(((color >> 16) & 255) * 0.65 + 255 * 0.35)
  const g = Math.round(((color >> 8) & 255) * 0.65 + 255 * 0.35)
  const b = Math.round((color & 255) * 0.65 + 255 * 0.35)
  return (r << 16) | (g << 8) | b
}

function updateGlassParticle(p: Particle): void {
  // Sample every family from absolute age: no frame-rate-dependent physics,
  // and a static preview cannot advance or perturb a particle trajectory.
  const u = p.age / p.life
  const travel = 108 * (1 - Math.exp(-p.age / 0.75))
  const swirl = (Math.sin(p.phase + p.age * 2.2) - Math.sin(p.phase)) * 8 * u
  p.x = p.originX + p.vx * travel + swirl
  p.y = p.originY + p.vy * travel + (p.glassKind === 'facet' ? 6 : 2) * p.age * p.age
  const sprite = p.sprite
  const size = p.size / (TEXTURE_RESOLUTION * 0.5)
  const envelope = Math.sin(Math.PI * u)
  sprite.position.set(p.x, p.y)
  switch (p.glassKind) {
    case 'facet': {
      const face = Math.abs(Math.cos(p.phase + p.age * 2.3))
      sprite.rotation = p.phase + p.age * 1.9
      sprite.scale.set(size * (0.2 + face * 0.8), size)
      sprite.alpha = Math.min(1, p.age / 0.08) * (1 - u) ** 0.8 * (0.4 + face * 0.6)
      break
    }
    case 'glint': {
      const flash = 0.25 + 0.75 * Math.abs(Math.sin(p.phase + u * 3.6)) ** 10
      sprite.rotation = p.phase + p.age * 0.3
      sprite.scale.set(size * (0.65 + flash * 0.35), size)
      sprite.alpha = envelope * flash * 0.95
      break
    }
    case 'ribbon':
      sprite.rotation = Math.atan2(p.vy, p.vx) + Math.PI / 2
      sprite.scale.set(size * 0.5, size * (0.6 + u))
      sprite.alpha = Math.min(1, p.age / 0.04) * Math.exp(-u * 3) * 0.7
      break
    case 'haze':
      sprite.rotation = 0
      sprite.scale.set(size * (1 + u * 0.7), size * (0.4 + u * 0.6))
      sprite.alpha = Math.min(1, p.age / 0.06) * (1 - u) ** 1.6 * 0.24
      break
    case 'dust':
      sprite.rotation = 0
      sprite.scale.set(size * (1 - u * 0.35))
      sprite.alpha = envelope * (0.65 + 0.2 * Math.sin(p.phase + u * 5))
      break
  }
}

// Build a 64×64 radial gradient texture once via Canvas 2D. All particles
// share it and recolour via Sprite.tint — zero per-frame geometry rebuilds.
// Tuned for additive blending: bright core + long soft tail so overlapping
// tails compound into a smooth bloom without any filter pass.
function buildRadialTexture(): Texture {
  const c = document.createElement('canvas')
  c.width = c.height = TEXTURE_RESOLUTION
  const ctx = c.getContext('2d')!
  const cx = TEXTURE_RESOLUTION / 2
  const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx)
  grad.addColorStop(0.0, 'rgba(255,255,255,1.00)')
  grad.addColorStop(0.18, 'rgba(255,255,255,0.75)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0.30)')
  grad.addColorStop(0.75, 'rgba(255,255,255,0.08)')
  grad.addColorStop(1.0, 'rgba(255,255,255,0.00)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, TEXTURE_RESOLUTION, TEXTURE_RESOLUTION)
  return Texture.from(c)
}

// All curves hold brightness early and taper out smoothly — a particle that
// "fades out naturally" rather than snapping off. u ∈ [0, 1]: age / life.
function alphaAt(curve: StyleConfig['fadeCurve'], u: number, phase: number, t: number): number {
  if (curve === 'ease-out') {
    const s = u < 0.25 ? 1 : clamp01(1 - (u - 0.25) / 0.75)
    return s * s * (3 - 2 * s)
  }
  if (curve === 'bell') {
    const b = Math.sin(u * Math.PI)
    return b * b
  }
  if (curve === 'swell') {
    // Bloom: rises quickly, brief plateau, then a long smooth fade. The
    // tightened plateau (was u<0.55, now u<0.25) and earlier taper are what
    // make the effect feel subtle instead of lingering.
    if (u < 0.08) return 0.75 + u * 3.125 // 0.75 → 1.0 across first 8%
    if (u < 0.25) return 1.0 // brief hold
    const tail = (u - 0.25) / 0.75 // 0 → 1 over final 75%
    const k = 1 - tail
    return k * k * (3 - 2 * k) // smoothstep out
  }
  if (curve === 'flash') {
    // Sparkle: deep pulse riding on an ease-out base. Each particle's own
    // phase + lightly varied rate creates genuine twinkle, not uniform flicker.
    const base = u < 0.1 ? 1 : clamp01(1 - (u - 0.1) / 0.9)
    const smooth = base * base * (3 - 2 * base)
    // Rate jitter: phase doubles as a per-particle frequency seed.
    const rate = 11 + ((phase * 1.7) % 5) // 11–16 Hz spread
    const pulse = 0.35 + 0.65 * Math.sin(t * rate + phase)
    return smooth * (pulse > 0 ? pulse : 0)
  }
  // twinkle (embers): subtle pulse riding on a smooth base fade.
  const base = u < 0.2 ? 1 : clamp01(1 - (u - 0.2) / 0.8)
  const smooth = base * base * (3 - 2 * base)
  const pulse = 0.82 + 0.18 * Math.sin(t * 8 + phase)
  return smooth * pulse
}

// Per-curve size factor — multiplied into the particle's nominal size.
function sizeFactorAt(curve: StyleConfig['fadeCurve'], u: number): number {
  if (curve === 'bell') return 0.6 + 0.5 * Math.sin(u * Math.PI)
  if (curve === 'swell') {
    // Grow from 70% → 100% by u=0.3, hold, slight shrink at the very end.
    if (u < 0.3) return 0.7 + (u / 0.3) * 0.3
    if (u < 0.85) return 1.0
    return 1.0 - ((u - 0.85) / 0.15) * 0.25 // 1.0 → 0.75
  }
  if (curve === 'flash') {
    // Starts large (instant bright point), gently shrinks so fades look crisp.
    return 1.1 - u * 0.55
  }
  return 1 - u * 0.45
}

function jitterColor(base: number, hueDeg: number, valueJ: number, random = Math.random): number {
  if (hueDeg === 0 && valueJ === 0) return base
  const r = (base >> 16) & 0xff
  const g = (base >> 8) & 0xff
  const b = base & 0xff
  const [h, s, l] = rgbToHsl(r, g, b)
  const nh = (h + (random() - 0.5) * 2 * hueDeg + 360) % 360
  const nl = clamp01(l + (random() - 0.5) * 2 * valueJ)
  const [nr, ng, nb] = hslToRgb(nh, s, nl)
  return (nr << 16) | (ng << 8) | nb
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0,
    s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rn:
        h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
        break
      case gn:
        h = ((bn - rn) / d + 2) * 60
        break
      case bn:
        h = ((rn - gn) / d + 4) * 60
        break
    }
  }
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0,
    g = 0,
    b = 0
  if (h < 60) {
    r = c
    g = x
  } else if (h < 120) {
    r = x
    g = c
  } else if (h < 180) {
    g = c
    b = x
  } else if (h < 240) {
    g = x
    b = c
  } else if (h < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
