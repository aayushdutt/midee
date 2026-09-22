#!/usr/bin/env node
// Batch MIDI → social-video renderer. Drives the REAL export path (the same
// WebCodecs encode the export dialog runs) in headless Chromium, once per input
// file, and drops the MP4s in an output folder with a manifest.
//
// Why a browser at all: MP4 export lives entirely in the page (VideoExporter +
// OfflineAudioRenderer + Pixi). There is no headless render path in Node, and
// building one would fork the renderer. e2e/export.spec.ts already proved the
// full encode works in headless Chromium with no special flags, so we reuse
// that: this is that test, looped, with the download written to disk.
//
// Usage:
//   npm run reels -- --in fixtures --out out/reels
//   npm run reels -- --in ~/midi/pop --format square --speed drama --limit 5
//
// Encoding is SOFTWARE in headless (no hardware encoder), so a minute of music
// at 1080x1920 takes a while. Files render sequentially on purpose — parallel
// encodes thrash the CPU and make every one of them slower.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Deliberately not bench.mjs's 4477 — so a render and a bench can coexist.
const PORT = 4478

// Source order of the <Segmented> groups in src/ui/ExportModal.tsx. These are
// index-addressed because the buttons are labelled by i18n text, which would
// make a text selector break under `?lang=`.
const SEG = { format: 0, quality: 1, fps: 2, focus: 3, speed: 4 }
const FORMATS = ['landscape', 'vertical', 'square']
const FPS_OPTIONS = [30, 60]
const FOCUS_OPTIONS = ['fit', 'all']
const SPEED_OPTIONS = ['compact', 'standard', 'drama']

const HELP = `midee batch reel renderer

usage: npm run reels -- [flags]

  --in DIR         folder of .mid/.midi files (default: fixtures)
  --out DIR        output folder (default: out/reels)
  --format F       landscape | vertical | square   (default: vertical)
  --fps N          30 | 60                          (default: 30)
  --focus F        fit | all                        (default: fit)
  --speed S        compact | standard | drama       (default: standard)
  --no-audio       render video only (much faster; use when you'll lay the
                   licensed platform track over it in the editor)
  --limit N        stop after N files
  --timeout MS     per-file export budget (default: 600000)
  --keep-going     don't stop the batch on a single failure
  -h, --help

Headless only by design: headed Chromium hangs on the export suites.`

// ── args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    in: 'fixtures',
    out: 'out/reels',
    format: 'vertical',
    fps: 30,
    focus: 'fit',
    speed: 'standard',
    audio: true,
    limit: Number.POSITIVE_INFINITY,
    timeout: 600_000,
    keepGoing: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) die(`${a} needs a value`)
      return v
    }
    switch (a) {
      case '-h':
      case '--help':
        console.log(HELP)
        process.exit(0)
        break
      case '--in':
        args.in = next()
        break
      case '--out':
        args.out = next()
        break
      case '--format':
        args.format = next()
        break
      case '--fps':
        args.fps = Number(next())
        break
      case '--focus':
        args.focus = next()
        break
      case '--speed':
        args.speed = next()
        break
      case '--no-audio':
        args.audio = false
        break
      case '--limit':
        args.limit = Number(next())
        break
      case '--timeout':
        args.timeout = Number(next())
        break
      case '--keep-going':
        args.keepGoing = true
        break
      default:
        die(`unknown flag: ${a}\n\n${HELP}`)
    }
  }
  if (!FORMATS.includes(args.format)) die(`--format must be one of ${FORMATS.join(', ')}`)
  if (!FPS_OPTIONS.includes(args.fps)) die('--fps must be 30 or 60')
  if (!FOCUS_OPTIONS.includes(args.focus)) die(`--focus must be one of ${FOCUS_OPTIONS.join(', ')}`)
  if (!SPEED_OPTIONS.includes(args.speed)) die(`--speed must be one of ${SPEED_OPTIONS.join(', ')}`)
  return args
}

function die(msg) {
  console.error(msg)
  process.exit(1)
}

// ── page driving ──────────────────────────────────────────────────────────

/** Click the nth option of the nth <Segmented> group in the settings phase. */
async function pickSegment(page, groupIndex, optionIndex) {
  const group = page.locator('#export-modal .export-settings .export-seg').nth(groupIndex)
  await group.locator('.fps-btn').nth(optionIndex).click()
}

async function renderOne(page, midPath, outDir, args) {
  const started = Date.now()

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' })

  // Hidden input, but setInputFiles works on it — same as e2e/export.spec.ts.
  const input = page.locator('#midi-input')
  await input.waitFor({ state: 'attached' })
  await input.setInputFiles(midPath)

  // Loading a file flips the app into play mode and un-hides the export button.
  const exportBtn = page.locator('#ts-record')
  await exportBtn.waitFor({ state: 'visible', timeout: 60_000 })
  await exportBtn.click()

  const modal = page.locator('#export-modal')
  await modal.waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForFunction(() => document.querySelector('#export-modal')?.classList.contains('open'), null, {
    timeout: 15_000,
  })

  // Defaults are landscape / 30fps / audio-on / fit / standard, so only the
  // deltas need clicking — but click unconditionally so the settings are
  // explicit rather than inherited.
  await pickSegment(page, SEG.format, FORMATS.indexOf(args.format))
  await pickSegment(page, SEG.fps, FPS_OPTIONS.indexOf(args.fps))
  if (args.format !== 'landscape') {
    // The framing/fall rows only apply to the social formats.
    await pickSegment(page, SEG.focus, FOCUS_OPTIONS.indexOf(args.focus))
    await pickSegment(page, SEG.speed, SPEED_OPTIONS.indexOf(args.speed))
  }
  if (!args.audio) {
    await page.locator('#export-modal .export-settings .export-toggle').click()
  }

  const downloadPromise = page.waitForEvent('download', { timeout: args.timeout })
  await page.locator('#export-modal .export-settings .modal-btn--accent').click()

  // The export can also land on the error phase, which never fires a download —
  // race the two so a failure reports its message instead of burning the budget.
  const errored = page
    .locator('#export-modal .export-card[data-phase="error"]')
    .waitFor({ state: 'attached', timeout: args.timeout })
    .then(async () => {
      const msg = await page.locator('#export-modal .export-error-msg').textContent()
      throw new Error(`export failed: ${msg?.trim() || 'unknown error'}`)
    })

  const download = await Promise.race([downloadPromise, errored])
  const suggested = download.suggestedFilename()
  const outPath = join(outDir, suggested)
  await copyFile(await download.path(), outPath)

  return { outPath, suggested, ms: Date.now() - started }
}

// ── plumbing ──────────────────────────────────────────────────────────────

function startPreview() {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let settled = false
    proc.stdout.on('data', (buf) => {
      if (!settled && buf.toString().includes(`localhost:${PORT}`)) {
        settled = true
        resolvePromise(proc)
      }
    })
    proc.on('exit', (code) => {
      if (!settled) rejectPromise(new Error(`vite preview exited with ${code}`))
    })
  })
}

async function newPage(browser) {
  const context = await browser.newContext({ acceptDownloads: true })
  // The app asks for Web MIDI on boot; granting it keeps the prompt out of the way.
  await context.grantPermissions(['midi', 'midi-sysex']).catch(() => {})
  const page = await context.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  page.on('crash', () => console.error('  [page CRASHED]'))
  return { context, page }
}

function listMidi(dir) {
  if (!existsSync(dir)) die(`--in folder not found: ${dir}`)
  return readdirSync(dir)
    .filter((f) => ['.mid', '.midi'].includes(extname(f).toLowerCase()))
    .sort()
    .map((f) => join(dir, f))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const inDir = resolve(ROOT, args.in)
  const outDir = resolve(ROOT, args.out)

  const files = listMidi(inDir).slice(0, args.limit)
  if (files.length === 0) die(`no .mid/.midi files in ${inDir}`)

  if (!existsSync(resolve(ROOT, 'dist'))) {
    die('no dist/ — run `npm run build` first (this renders against the built app)')
  }
  mkdirSync(outDir, { recursive: true })

  console.log(`rendering ${files.length} file(s) → ${outDir}`)
  console.log(`  ${args.format} @ ${args.fps}fps · focus=${args.focus} · fall=${args.speed} · audio=${args.audio}\n`)

  const server = await startPreview()
  let browser
  const results = []
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    })

    for (const [i, midPath] of files.entries()) {
      const label = `[${i + 1}/${files.length}] ${midPath.slice(inDir.length + 1)}`
      process.stdout.write(`${label} … `)
      const { context, page } = await newPage(browser)
      try {
        const res = await renderOne(page, midPath, outDir, args)
        console.log(`✓ ${res.suggested} (${(res.ms / 1000).toFixed(1)}s)`)
        results.push({ input: midPath, ok: true, ...res })
      } catch (err) {
        console.log(`✗ ${err.message}`)
        results.push({ input: midPath, ok: false, error: err.message })
        if (!args.keepGoing) throw err
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
  }

  const manifest = {
    renderedAt: new Date().toISOString(),
    settings: { format: args.format, fps: args.fps, focus: args.focus, speed: args.speed, audio: args.audio },
    results,
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed} rendered, ${failed} failed → ${outDir}`)
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
