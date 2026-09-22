import { Texture } from 'pixi.js'
import { createLiquidEnvironmentTexture } from './LiquidGlassNotes'
import { makeGlassAtmosphere } from './SmokedGlassNotes'
import { hexToCSS, type Theme } from './theme'

export function makeMaterialAtmosphere(theme: Theme): Texture {
  if (theme.noteMaterial === 'liquid-glass') return createLiquidEnvironmentTexture()
  if (theme.noteMaterial === 'smoked-glass') return makeGlassAtmosphere()
  const c = document.createElement('canvas')
  c.width = c.height = 512
  const ctx = c.getContext('2d')!
  const horizon = theme.atmosphere?.horizon ?? theme.background
  const glowColor = hexToCSS(theme.atmosphere?.light ?? theme.accent)
  const wash = ctx.createLinearGradient(0, 0, 0, 512)
  wash.addColorStop(0, hexToCSS(theme.background))
  wash.addColorStop(1, hexToCSS(horizon))
  ctx.fillStyle = wash
  ctx.fillRect(0, 0, 512, 512)
  const glow = ctx.createRadialGradient(260, 485, 0, 260, 485, 370)
  glow.addColorStop(0, `${glowColor}12`)
  glow.addColorStop(1, `${glowColor}00`)
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, 512, 512)
  const vignette = ctx.createRadialGradient(256, 360, 60, 256, 300, 390)
  vignette.addColorStop(0, 'rgba(0,0,0,0)')
  vignette.addColorStop(1, 'rgba(0,0,0,0.65)')
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, 512, 512)
  return Texture.from(c)
}
