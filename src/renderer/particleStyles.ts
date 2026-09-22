import { availableVisuals, FOR_LATER_PARTICLE_IDS } from './forLater/visuals'
import type { MaterialParticleStyle } from './materialParticles'

export type ParticleStyle =
  | 'sparks'
  | 'embers'
  | 'bloom'
  | 'sparkle'
  | 'none'
  | 'glass'
  | MaterialParticleStyle

export interface ParticleStyleInfo {
  id: ParticleStyle
  name: string
}

// Historical order is immutable: old localStorage indices migrate through it.
export const ALL_PARTICLE_STYLES: readonly ParticleStyleInfo[] = [
  { id: 'sparks', name: 'Sparks' },
  { id: 'embers', name: 'Embers' },
  { id: 'bloom', name: 'Bloom' },
  { id: 'sparkle', name: 'Sparkle' },
  { id: 'none', name: 'Off' },
  { id: 'glass', name: 'Glass glints' },
  { id: 'silk', name: 'Silk fibers' },
  { id: 'gold', name: 'Gold leaf' },
  { id: 'pearl', name: 'Opal dust' },
  { id: 'liquid', name: 'Glass dust' },
  { id: 'mist', name: 'Windblown mist' },
]

export const PARTICLE_STYLES = availableVisuals(ALL_PARTICLE_STYLES, FOR_LATER_PARTICLE_IDS)
