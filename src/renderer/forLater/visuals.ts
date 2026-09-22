// Explicit build-time opt-in. Public builds omit this flag; deferred designs
// stay available for development without entering menus or shortcut cycling.
export const ENABLE_FOR_LATER_VISUALS = import.meta.env.VITE_ENABLE_FOR_LATER_VISUALS === '1'

export const FOR_LATER_THEME_IDS = [
  'smoked-glass',
  'aurora-silk',
  'lacquer-gold',
  'ember-mist',
] as const
export const FOR_LATER_PARTICLE_IDS = ['glass', 'silk', 'gold', 'mist'] as const

export function availableVisuals<T extends { id: string }>(
  catalog: readonly T[],
  deferredIds: readonly string[],
  includeDeferred = ENABLE_FOR_LATER_VISUALS,
): readonly T[] {
  return includeDeferred ? catalog : catalog.filter(({ id }) => !deferredIds.includes(id))
}
