import type { Container } from 'pixi.js'

export type NoteMaterialId =
  | 'smoked-glass'
  | 'aurora-silk'
  | 'lacquer-gold'
  | 'opal'
  | 'liquid-glass'
  | 'ember-mist'

// Timing/layout stay in the scheduled and live renderers. A material owns
// only appearance, pooled GPU resources and their explicit lifecycle.
// Height is the full note duration, including any portion below the keys.
// Scheduled notes are clipped by the caller, never compressed as consumed.
export interface NoteMaterial {
  readonly container: Container
  setViewport?(width: number, height: number): void
  begin(): void
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
  ): void
  end(): void
  clear(): void
  destroy(): void
}
