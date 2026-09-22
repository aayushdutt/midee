import { LacquerNotes } from '../LacquerNotes'
import { NaturalMaterialNotes } from '../NaturalMaterialNotes'
import type { NoteMaterial, NoteMaterialId } from '../NoteMaterial'
import { SmokedGlassNotes } from '../SmokedGlassNotes'
import { EmberMistNotes } from './EmberMistNotes'

// Kept behind the build-time gate in the shipping factory.
export function createForLaterNoteMaterial(id: NoteMaterialId): NoteMaterial {
  switch (id) {
    case 'ember-mist':
      return new EmberMistNotes()
    case 'smoked-glass':
      return new SmokedGlassNotes()
    case 'aurora-silk':
      return new NaturalMaterialNotes(id)
    case 'lacquer-gold':
      return new LacquerNotes()
    default:
      throw new Error(`Unknown deferred note material: ${id}`)
  }
}
