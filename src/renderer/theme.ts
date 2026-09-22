import type { MidiTrack } from '../core/midi/types'
import { availableVisuals, FOR_LATER_THEME_IDS } from './forLater/visuals'
import type { NoteMaterialId } from './NoteMaterial'
import type { ParticleStyle } from './particleStyles'

// Persisted in localStorage (`midee.theme`) — never rename.
export type ThemeId = 'dark' | 'midnight' | 'neon' | 'sunset' | 'ocean' | NoteMaterialId

export interface Theme {
  id: ThemeId
  name: string
  background: number
  noteMaterial?: NoteMaterialId
  recommendedParticles?: ParticleStyle
  // Art direction for the environment and the Appearance material swatch.
  atmosphere?: { horizon: number; light: number }
  preview?: string

  noteRadius: number
  noteGlowStrength: number
  noteGlowDistance: number

  whiteKey: number
  whiteKeyActive: number // color of white key when pressed
  blackKey: number
  blackKeyActive: number // color of black key when pressed
  keyBorder: number

  nowLine: number
  nowLineAlpha: number
  nowLineGlow: number

  beatLineAlpha: number
  barLineAlpha: number

  // UI accent as a Pixi hex; CSS gets its string form via `accentCSS()`.
  accent: number

  // Per-track note/particle colors — indexed by MidiTrack.colorIndex
  trackColors: number[]
}

// 0xRRGGBB → '#rrggbb'. Lives here so the renderer never imports UI code.
export function hexToCSS(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

export function accentCSS(theme: Theme): string {
  return hexToCSS(theme.accent)
}

// Colour for the user's own live notes, particles, and key highlights.
export function liveNoteColor(theme: Theme): number {
  return theme.trackColors[0] ?? theme.nowLine
}

export function getTrackColor(track: MidiTrack, theme: Theme): number {
  return theme.trackColors[track.colorIndex % theme.trackColors.length]!
}

export const darkTheme: Theme = {
  id: 'dark',
  name: 'Dark',
  background: 0x09090f,
  noteRadius: 8,
  noteGlowStrength: 2.5,
  noteGlowDistance: 12,
  whiteKey: 0xe8e8f0,
  whiteKeyActive: 0xb0b4ff, // soft indigo when pressed
  blackKey: 0x1a1a2e,
  blackKeyActive: 0x5558cc, // deeper indigo
  keyBorder: 0x1e1e30,
  nowLine: 0xffffff,
  nowLineAlpha: 0.18,
  nowLineGlow: 0xffffff,
  beatLineAlpha: 0.028,
  barLineAlpha: 0.07,
  accent: 0x6366f1,
  trackColors: [0x6366f1, 0x818cf8, 0x60a5fa, 0xa78bfa, 0xf472b6, 0x34d399, 0xfbbf24, 0xfb923c],
}

export const midnightTheme: Theme = {
  id: 'midnight',
  name: 'Midnight',
  background: 0x050510,
  noteRadius: 8,
  noteGlowStrength: 2.2,
  noteGlowDistance: 14,
  whiteKey: 0xd0d0f0,
  whiteKeyActive: 0xc4b0ff, // lavender when pressed
  blackKey: 0x0e0e28,
  blackKeyActive: 0x7c5ce8, // violet
  keyBorder: 0x14142a,
  nowLine: 0xaaaaff,
  nowLineAlpha: 0.16,
  nowLineGlow: 0xaaaaff,
  beatLineAlpha: 0.025,
  barLineAlpha: 0.06,
  accent: 0xa78bfa,
  trackColors: [0xa78bfa, 0xc084fc, 0x818cf8, 0xe879f9, 0x7dd3fc, 0xf9a8d4, 0x93c5fd, 0x6ee7b7],
}

export const neonTheme: Theme = {
  id: 'neon',
  name: 'Neon',
  background: 0x030306,
  noteRadius: 8,
  noteGlowStrength: 4.5,
  noteGlowDistance: 20,
  whiteKey: 0xf0f0f0,
  whiteKeyActive: 0x80ffcc, // mint green when pressed
  blackKey: 0x111116,
  blackKeyActive: 0x00bb7a, // deep teal
  keyBorder: 0x181820,
  nowLine: 0x00ffaa,
  nowLineAlpha: 0.28,
  nowLineGlow: 0x00ffaa,
  beatLineAlpha: 0.035,
  barLineAlpha: 0.09,
  accent: 0x00d4aa,
  trackColors: [0x00ffaa, 0x00e5ff, 0x39ff14, 0xff6bff, 0xffe600, 0xff4040, 0x00bfff, 0xff9100],
}

export const sunsetTheme: Theme = {
  id: 'sunset',
  name: 'Sunset',
  background: 0x0e0608,
  noteRadius: 8,
  noteGlowStrength: 3.0,
  noteGlowDistance: 15,
  whiteKey: 0xf2e8e8,
  whiteKeyActive: 0xffb08a, // warm orange when pressed
  blackKey: 0x200e10,
  blackKeyActive: 0xcc4e20, // burnt orange
  keyBorder: 0x271416,
  nowLine: 0xff8c5a,
  nowLineAlpha: 0.22,
  nowLineGlow: 0xff8c5a,
  beatLineAlpha: 0.03,
  barLineAlpha: 0.075,
  accent: 0xf97316,
  trackColors: [0xf97316, 0xfbbf24, 0xef4444, 0xec4899, 0xff8c5a, 0xfde68a, 0xff6b9d, 0xfca5a5],
}

export const oceanTheme: Theme = {
  id: 'ocean',
  name: 'Ocean',
  background: 0x040d14,
  noteRadius: 8,
  noteGlowStrength: 2.8,
  noteGlowDistance: 16,
  whiteKey: 0xe0eef8,
  whiteKeyActive: 0x7dd8ff, // sky blue when pressed
  blackKey: 0x081825,
  blackKeyActive: 0x0a6ea8, // deep ocean blue
  keyBorder: 0x0c1e2e,
  nowLine: 0x38bdf8,
  nowLineAlpha: 0.2,
  nowLineGlow: 0x38bdf8,
  beatLineAlpha: 0.028,
  barLineAlpha: 0.07,
  accent: 0x38bdf8,
  trackColors: [0x38bdf8, 0x06b6d4, 0x6366f1, 0x34d399, 0xa78bfa, 0x4ade80, 0x22d3ee, 0x67e8f9],
}

// A deliberately narrow mineral palette: ice blue and moonstone lead, with
// desaturated jade / steel supporting additional tracks. Highlights and
// particles inherit these hues, rather than introducing unrelated colours.
export const smokedGlassTheme: Theme = {
  id: 'smoked-glass',
  name: 'Smoked Glass',
  noteMaterial: 'smoked-glass',
  preview:
    'linear-gradient(115deg, #d6eef3 0%, #5a8495 12%, #152938 40%, #294455 78%, #9fc9d7 100%)',
  recommendedParticles: 'glass',
  background: 0x080f19,
  noteRadius: 4,
  noteGlowStrength: 0,
  noteGlowDistance: 12,
  whiteKey: 0xb9c6d0,
  whiteKeyActive: 0xc9edf4,
  blackKey: 0x101b27,
  blackKeyActive: 0x4e798d,
  keyBorder: 0x1b2a38,
  nowLine: 0xc4e7ee,
  nowLineAlpha: 0.3,
  nowLineGlow: 0x8ac9da,
  beatLineAlpha: 0.022,
  barLineAlpha: 0.055,
  accent: 0x91cddd,
  trackColors: [0x91cddd, 0xabb8db, 0x83bdb1, 0xc0cddb, 0x7eabd0, 0xbeb9cd, 0x89b7c7, 0xaabdbb],
}

export const auroraSilkTheme: Theme = {
  ...smokedGlassTheme,
  id: 'aurora-silk',
  name: 'Aurora Silk',
  noteMaterial: 'aurora-silk',
  recommendedParticles: 'silk',
  background: 0x071410,
  atmosphere: { horizon: 0x142d27, light: 0x6caa91 },
  preview:
    'linear-gradient(105deg, #174c43, #a0ddbd 27%, #377b72 40%, #183b3b 65%, #9fbca0 85%, #2e665c)',
  accent: 0x90cbb3,
  whiteKey: 0xc6d2c9,
  blackKey: 0x111e1b,
  keyBorder: 0x22352d,
  nowLine: 0xccebd4,
  nowLineGlow: 0x8fd2b9,
  nowLineAlpha: 0.22,
  trackColors: [0x78d9c4, 0xd8c494, 0x8cbfd8, 0xb3d59c, 0xb8c1d0, 0x9acbc2, 0xc8c5a5, 0x86b8a1],
}

export const lacquerGoldTheme: Theme = {
  ...smokedGlassTheme,
  id: 'lacquer-gold',
  name: 'Lacquer & Gold',
  noteMaterial: 'lacquer-gold',
  recommendedParticles: 'gold',
  background: 0x110b10,
  atmosphere: { horizon: 0x291b20, light: 0xb78252 },
  preview:
    'linear-gradient(105deg, #ebce91, #4a2429 9%, #6e3543 27%, #21101e 57%, #342024 90%, #d5aa62)',
  accent: 0xd4b078,
  whiteKey: 0xd2c9bb,
  blackKey: 0x21161b,
  keyBorder: 0x382831,
  nowLine: 0xe7c793,
  nowLineGlow: 0xd3a465,
  nowLineAlpha: 0.2,
  trackColors: [0xe2bb77, 0xc78899, 0xcc9d6d, 0xb0a49a, 0xb98677, 0xcebc96, 0xb499b1, 0xbbaa83],
}

export const opalTheme: Theme = {
  ...smokedGlassTheme,
  id: 'opal',
  name: 'Opal',
  noteMaterial: 'opal',
  recommendedParticles: 'pearl',
  background: 0x14151b,
  atmosphere: { horizon: 0x2b3037, light: 0xaaa5a3 },
  preview:
    'linear-gradient(115deg, #b7aaa4, #f4e9dc 24%, #c7dcd3 40%, #ead4d3 60%, #d0cade 78%, #eddfc9)',
  accent: 0xdccabc,
  whiteKey: 0xdad6ce,
  blackKey: 0x20232a,
  keyBorder: 0x343740,
  nowLine: 0xece4dc,
  nowLineGlow: 0xd3c8d6,
  nowLineAlpha: 0.17,
  trackColors: [0xe7c5b8, 0xc0dad0, 0xd9cbe3, 0xe5d6b7, 0xbccfdc, 0xddbfc5, 0xd1d5c0, 0xc9c6d8],
}

export const liquidGlassTheme: Theme = {
  ...smokedGlassTheme,
  id: 'liquid-glass',
  name: 'Liquid Glass',
  noteMaterial: 'liquid-glass',
  recommendedParticles: 'liquid',
  background: 0x071923,
  atmosphere: { horizon: 0x173840, light: 0xa8d9d5 },
  preview:
    'linear-gradient(115deg, #ddf7f4, #426d74 9%, #172f38 24%, #37575e 50%, #d3eeeb 57%, #24464e 66%, #a9d8d8)',
  accent: 0xa8d9d5,
  whiteKey: 0xc0d2d1,
  blackKey: 0x13282d,
  keyBorder: 0x28434a,
  nowLine: 0xe1f2ec,
  nowLineGlow: 0xbce8df,
  nowLineAlpha: 0.2,
  trackColors: [0xa8dbd6, 0xc7d5e4, 0xb8d9cc, 0xdbd9c7, 0xa6c8d9, 0xcdcbdc, 0xb6d1ce, 0xc4dedf],
}

// Deferred experiment: a cool upper register, rose middle tones and amber
// illumination at the strike edge. The material itself follows world height.
export const emberMistTheme: Theme = {
  ...smokedGlassTheme,
  id: 'ember-mist',
  name: 'Ember Mist',
  noteMaterial: 'ember-mist',
  recommendedParticles: 'mist',
  background: 0x0c0811,
  atmosphere: { horizon: 0x24131d, light: 0xac7260 },
  preview: 'linear-gradient(135deg, #7043be, #bb7191 48%, #ffc269)',
  accent: 0xe5ad78,
  whiteKey: 0xd4ccd2,
  whiteKeyActive: 0xffdc9e,
  blackKey: 0x1d1624,
  blackKeyActive: 0xb36c43,
  keyBorder: 0x322332,
  nowLine: 0xffe5b2,
  nowLineGlow: 0xffb767,
  nowLineAlpha: 0.65,
  beatLineAlpha: 0.018,
  barLineAlpha: 0.04,
  trackColors: [0xedb17b, 0xe0a286, 0xf0c08b, 0xe9b198, 0xe7a775, 0xdfb996, 0xf3c896, 0xe2a78c],
}

// Historical order is immutable: old localStorage indices migrate through it.
export const ALL_THEMES: readonly Theme[] = [
  darkTheme,
  midnightTheme,
  neonTheme,
  sunsetTheme,
  oceanTheme,
  smokedGlassTheme,
  auroraSilkTheme,
  lacquerGoldTheme,
  opalTheme,
  liquidGlassTheme,
  emberMistTheme,
]

// Every user entry point (menu, cycling, persistence) uses this shipping roster.
export const THEMES = availableVisuals(ALL_THEMES, FOR_LATER_THEME_IDS)
