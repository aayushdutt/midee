// Generates @font-face CSS for static content pages (blog / vs / guides) by
// reading the hashed woff2 files Vite emitted into `dist/assets/`. Lets the
// blog drop the fonts.googleapis.com / fonts.gstatic.com cross-origin chain
// and reuse the same self-hosted font assets the SPA ships (~24 KB each,
// served from the warm same-origin HTTP/2 connection).
//
// Runs in postbuild (after `vite build`), so the hashed asset filenames
// already exist on disk. The matching pattern is the @fontsource convention:
//   <pkg>-latin-<weight>-<style>-<HASH>.woff2
//
// Returns:
//   { fontFaces: '<style>…@font-face{…}…</style>',
//     fontPreload: '<link rel="preload" as="font" …>' }
// Both strings are HTML-ready; the body font (Inter 400) is preloaded so its
// fetch parallelises with HTML parse rather than waiting for the inline
// <style> to be parsed.

import { readdirSync } from 'node:fs'

const FAMILY_NAME = {
  inter: 'Inter',
  'instrument-serif': 'Instrument Serif',
  'jetbrains-mono': 'JetBrains Mono',
}

// Mirror src/main.tsx's @fontsource import set. If you add a weight there,
// add it here so the blog renders with the same typography.
const WEIGHTS = [
  ['inter', 400, 'normal'],
  ['inter', 500, 'normal'],
  ['inter', 600, 'normal'],
  ['inter', 700, 'normal'],
  ['instrument-serif', 400, 'normal'],
  ['instrument-serif', 400, 'italic'],
  ['jetbrains-mono', 400, 'normal'],
  ['jetbrains-mono', 500, 'normal'],
  ['jetbrains-mono', 600, 'normal'],
]

export function renderFontTags(distAssetsDir) {
  let files
  try {
    files = readdirSync(distAssetsDir)
  } catch {
    // dist/assets doesn't exist yet (e.g. building content before Vite).
    // Fail loud — the static pages would render with wrong fonts otherwise.
    throw new Error(`fonts-css: ${distAssetsDir} not found; run vite build first`)
  }

  // Build a lookup keyed by `<pkg>-<weight>-<style>` → hashed filename.
  const woff2 = new Map()
  for (const f of files) {
    const m = f.match(/^([a-z-]+?)-latin-(\d{3})-(normal|italic)-[A-Za-z0-9_-]+\.woff2$/)
    if (m) woff2.set(`${m[1]}-${m[2]}-${m[3]}`, f)
  }

  const faces = WEIGHTS.map(([pkg, weight, style]) => {
    const file = woff2.get(`${pkg}-${weight}-${style}`)
    if (!file) {
      throw new Error(`fonts-css: missing woff2 for ${pkg} ${weight} ${style}`)
    }
    return (
      `@font-face{` +
      `font-family:'${FAMILY_NAME[pkg]}';` +
      `font-style:${style};` +
      `font-weight:${weight};` +
      `font-display:swap;` +
      `src:url(/assets/${file}) format('woff2')` +
      `}`
    )
  }).join('')

  const inter400 = woff2.get('inter-400-normal')
  const fontPreload = inter400
    ? `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/${inter400}" />`
    : ''

  return {
    fontFaces: `<style>${faces}</style>`,
    fontPreload,
  }
}
