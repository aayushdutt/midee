// Overwrites dist/sitemap.xml with today's date in <lastmod>.
// Runs as `postbuild` so Vite's copy of public/sitemap.xml is replaced with
// the freshly-stamped version. Keeps the source file (public/sitemap.xml)
// unchanged to avoid noisy git diffs on every build.

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const today = new Date().toISOString().slice(0, 10)

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://midee.app/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`

const out = resolve(process.cwd(), 'dist/sitemap.xml')
writeFileSync(out, xml, 'utf8')
console.log(`[stamp-sitemap] dist/sitemap.xml lastmod=${today}`)
