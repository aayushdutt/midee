import { beforeEach, describe, expect, it } from 'vitest'
import { idPersisted } from '../../core/persistence'
import { ALL_PARTICLE_STYLES, PARTICLE_STYLES } from '../particleStyles'
import { ALL_THEMES, THEMES } from '../theme'
import { availableVisuals, FOR_LATER_PARTICLE_IDS, FOR_LATER_THEME_IDS } from './visuals'

beforeEach(() => localStorage.clear())

describe('visual release gate', () => {
  it('ships only the two final materials and keeps their paired effects available', () => {
    expect(THEMES.filter((theme) => theme.noteMaterial).map(({ id }) => id)).toEqual([
      'opal',
      'liquid-glass',
    ])
    expect(PARTICLE_STYLES.map(({ id }) => id)).toEqual([
      'sparks',
      'embers',
      'bloom',
      'sparkle',
      'none',
      'pearl',
      'liquid',
    ])
    for (const theme of THEMES) {
      if (theme.recommendedParticles) {
        expect(PARTICLE_STYLES.some(({ id }) => id === theme.recommendedParticles)).toBe(true)
      }
    }
  })

  it('restores the full catalog only with explicit opt-in', () => {
    expect(availableVisuals(ALL_THEMES, FOR_LATER_THEME_IDS, true)).toBe(ALL_THEMES)
    expect(availableVisuals(ALL_PARTICLE_STYLES, FOR_LATER_PARTICLE_IDS, true)).toBe(
      ALL_PARTICLE_STYLES,
    )
    expect(availableVisuals(ALL_THEMES, FOR_LATER_THEME_IDS, false)).toEqual(THEMES)
  })

  it.each([
    ['theme', ALL_THEMES, THEMES, 'sunset'],
    ['particle', ALL_PARTICLE_STYLES, PARTICLE_STYLES, 'embers'],
  ] as const)('migrates original %s indices without shifting hidden entries', (kind, catalog, available, fallback) => {
    const key = `midee.${kind}`
    const legacyKey = `${key}Index`
    const validIds = available.map(({ id }) => id)
    const store = idPersisted<string>(key, fallback, validIds, {
      key: legacyKey,
      ids: catalog.map(({ id }) => id),
    })
    catalog.forEach(({ id }, index) => {
      localStorage.removeItem(key)
      localStorage.setItem(legacyKey, String(index))
      expect(store.load()).toBe(validIds.some((valid) => valid === id) ? id : fallback)
    })
  })

  it.each([
    'lacquer-gold',
    'ember-mist',
  ])('preserves deferred saved preference %s when falling back', (id) => {
    const store = idPersisted(
      'midee.theme',
      'sunset',
      THEMES.map(({ id }) => id),
    )
    localStorage.setItem('midee.theme', id)
    expect(store.load()).toBe('sunset')
    expect(localStorage.getItem('midee.theme')).toBe(id)
  })
})
