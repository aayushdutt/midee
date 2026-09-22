import { createForLaterNoteMaterial } from './forLater/createNoteMaterial'
import { ENABLE_FOR_LATER_VISUALS } from './forLater/visuals'
import { LiquidGlassNotes } from './LiquidGlassNotes'
import { NaturalMaterialNotes } from './NaturalMaterialNotes'
import type { NoteMaterial, NoteMaterialId } from './NoteMaterial'

export function createNoteMaterial(id: NoteMaterialId): NoteMaterial {
  switch (id) {
    case 'opal':
      return new NaturalMaterialNotes(id)
    case 'liquid-glass':
      return new LiquidGlassNotes()
    default:
      if (ENABLE_FOR_LATER_VISUALS) return createForLaterNoteMaterial(id)
      throw new Error(`Note material is not enabled: ${id}`)
  }
}
