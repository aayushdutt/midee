#!/usr/bin/env node
// Perf-harness driver — the orchestration half. The in-page measurement half
// is src/bench/runner.ts; see docs/BENCH_HARNESS_V2_2026-07-02.md.
//
// Usage (all through `npm run bench -- <flags>` or `npm run bench:run -- <flags>`):
//   --suite frame,attribution,live,idle   suites to run (default shown)
//   --fixture id,id                       fixtures (default: all, from the page)
//   --cpu N                               CDP CPU throttling (4 ≈ mid-tier phone)
//   --no-gpu                              software raster — GPU cost becomes CPU-visible
//   --dpr N / --viewport WxH              raster-load emulation
//   --device phone|slow                   presets (phone: 390x844@3 + cpu4; slow: cpu6)
//   --headed                              required for the `pacing` suite
//   --runs N                              repeats per suite, best run wins (default 2)
//   --update                              merge results into baseline FOR THIS ENV
//   --json                                machine-readable output
//   --browser chrome,safari               real-browser mode (macOS), see below
//   --res 720p,1080p,4k / --fps 30,60     preset matrix for the export-size suites
//                                         (exportreal, exportlab, exportstages,
//                                         encodemax, encodepar)
//
// Baseline entries are keyed `envKey :: suite :: fixture`, so numbers from
// different device profiles never get compared against each other — the
// failure mode that made the v1 harness report a +5078% phantom regression.
//
// Real-browser mode (`--browser`): headless Chromium renders on SwiftShader
// and encodes with software H.264, and headed Playwright hangs on export
// suites — so export numbers from either say little about users. Instead the
// driver `open -a`s each run URL in the user's real Chrome/Safari (real GPU,
// hardware encoder) with `&report=<sink>`; the page POSTs progress + result
// to a local sink (:4478). Runs are strictly sequential (two exports would
// contend for the encoder) and each tab is closed via osascript afterwards.
// Env keys are `real|<browser>-<major>|<chip>`, taken from the UA the page
// reports, so they never meet headless numbers. A tab in the user's own
// window goes hidden (and throttled) the moment they switch tabs, so
// `chrome-iso` runs Chrome as a dedicated instance and Safari runs get their
// own window; every result carries `hiddenMs` and hidden runs are flagged.
//
// The bench build lives in dist-bench/ (never dist/: e2e's webServer builds
// that concurrently).

import { execFile, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BENCH_DIR = resolve(ROOT, 'bench')
const LATEST_PATH = resolve(BENCH_DIR, 'latest.json')
const BASELINE_PATH = resolve(BENCH_DIR, 'baseline.json')
const OUT_DIR = 'dist-bench'
const PORT = 4477
const SINK_PORT = 4478
const DEFAULT_TIMEOUT_S = 300
const execFileAsync = promisify(execFile)

// Real browsers by --browser id: the macOS app to `open -a`, and where the
// major version sits in its UA. `chrome-iso` is the same Chrome app run as a
// separate, dedicated instance (see ISO_CHROME below).
const REAL_BROWSERS = {
  chrome: { app: 'Google Chrome', version: /Chrome\/(\d+)/ },
  'chrome-iso': { app: 'Google Chrome', version: /Chrome\/(\d+)/ },
  safari: { app: 'Safari', version: /Version\/(\d+)/ },
}
// `--browser chrome-iso`: the installed Chrome (real GPU, VideoToolbox) as a
// second instance with its own profile under bench/, so bench tabs live in
// their own window — a user browsing in their own Chrome can't switch the
// bench tab into the background (a hidden tab's timers are throttled to ~1 Hz,
// which silently wrecks export timings; seen 2026-09-27). The flags keep an
// occluded window's page treated as visible. Tabs are opened and closed via
// the DevTools HTTP endpoint on ISO_CHROME.port; the instance is quit when
// the driver exits.
const ISO_CHROME = {
  port: 9333,
  profile: resolve(BENCH_DIR, '.chrome-iso-profile'),
  flags: [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
  ],
}
// Where real-browser windows go: a secondary display when one is attached (e.g.
// the laptop screen beside the main monitor), else the main one. Runs open
// without taking focus, so a matrix can run while the user keeps working —
// isolated Chrome ignores occlusion (flags above) and a visible Safari window
// on another screen isn't throttled; `hiddenMs` still flags any run that was.
// Top-left global coordinates: what --window-position and AppleScript bounds use.
let benchWindowRect
function benchWindow() {
  if (benchWindowRect !== undefined) return benchWindowRect
  const js =
    'ObjC.import("AppKit");const s=$.NSScreen.screens;const m=s.objectAtIndex(0).frame;const r=[];' +
    'for(let i=0;i<s.count;i++){const f=s.objectAtIndex(i).frame;' +
    'r.push([f.origin.x,m.size.height-(f.origin.y+f.size.height),f.size.width,f.size.height])}JSON.stringify(r)'
  try {
    const out = spawnSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8', timeout: 5000 })
    const screens = JSON.parse(out.stdout)
    const [x, y, w, h] = screens[1] ?? screens[0]
    benchWindowRect = { x: x + 40, y: y + 40, w: Math.min(1280, w - 80), h: Math.min(800, h - 80) }
  } catch {
    benchWindowRect = null
  }
  return benchWindowRect
}
// Kill switches run on SIGINT/SIGTERM too: without them an interrupted run
// orphans `vite preview` on :4477 (and the isolated Chrome).
const cleanups = []
// Export-size presets (validated again in-page). Each res × fps pair is its own
// baseline row: `bach-prelude-c@1080p30`.
const EXPORTREAL_RES = ['720p', '1080p', '4k']
const EXPORTREAL_FPS = [30, 60]
// What covers the canvas during exportreal (see applyExportOverlay in runner.ts).
const EXPORT_OVERLAYS = ['none', 'modal', 'opaque', 'bare']
// Suites that take the --res/--fps matrix (`&res=…&fps=…`).
const RES_SUITES = new Set([
  'exportreal',
  'exportlab',
  'exportstages',
  'glowshots',
  'encodemax',
  'encodepar',
  'exportquality',
])
// Where pages store files through the sink (`POST /f/<token>/<name>`):
// exportquality's MP4s, for ffprobe / AVFoundation checks outside the browser.
const EXPORTS_DIR = resolve(BENCH_DIR, 'exports')
// Which of a suite's repeated runs is kept (lowest score wins). Default is
// the frame median; suites without one say what "best" means here.
const RUN_SCORE = {
  exportreal: (m) => m.wallMs,
}
// Sweep suites: a bag of `<variant>_<metric>` cells with no single score, so
// repeated runs are merged per metric (median; mean of two for --runs 2)
// and printed as one variant × metric table per row. Values listed here are
// the columns; every run's raw metrics also land in bench/latest.json.
// See docs/EXPORT_PERF_MEASUREMENTS_2026-09-27.md.
const PIVOT_SUITES = {
  exportlab: ['fps', 'stall'],
  // (scalars such as exportstages' coldLat print in the table heading)
  exportstages: [
    'fps',
    'steady',
    'lat',
    'update',
    'submit',
    'capture',
    'encodeCall',
    'stall',
    'yield',
    'other',
    'gpu',
    'captureGpu',
    'captureIdle',
    'syncRt',
    'gpuQuery',
  ],
  encodemax: ['fps', 'steady', 'lat', 'kbpf', 'dq'],
  encodepar: ['steady', 'fps', 'x'],
  exportquality: [
    'wall',
    'fps',
    'mb',
    'kbps',
    'tgt',
    'psnr',
    'psnrMin',
    'ssim',
    'ssimMin',
    'bias',
    'frames',
    'ptsErr',
    'reorders',
    'keyOff',
    'firstPts',
    'onset',
    'onsetD',
    'hw',
    'steps',
    'saved',
  ],
}

const DEFAULT_SUITES = ['frame', 'attribution', 'live', 'idle']
// Suites where the fixture doesn't matter — run once on the densest fixture.
const FIXTURE_INDEPENDENT = new Set(['idle'])
// Suites that run on the in-page synthetic audio fixtures (`?bench=list`
// publishes them as __BENCH_AUDIO_FIXTURES) instead of MIDI files, and whose
// metrics are per-instrument rows rather than per-fixture columns. They're
// deterministic (offline render), so they run once unless --runs is explicit.
// See docs/AUDIO_GLITCH_HARNESS_2026-09-05.md.
const AUDIO_SUITES = new Set(['headroom', 'voiceload'])
const AUDIO_METRICS = {
  headroom: ['peakDb', 'clipPct', 'aboveKneePct', 'firstClipNotes', 'rmsDb', 'lufsM'],
  voiceload: ['driftMs', 'firstDriftNote'],
}
// voiceload drives the live synth by hand (no MIDI); its fixture is nominal.
const SUITE_FIXED_FIXTURE = { voiceload: 'stack-185' }
// Regression gates. `pct` metrics fail at >+10% vs baseline; `pctInverse`
// metrics fail at <-10% (higher-is-better, e.g. encode throughput); `abs`
// metrics fail above the absolute limit with no baseline needed.
const GATES = {
  pct: [
    'medianFrameMs',
    'p95FrameMs',
    'medianRenderMs',
    'p95RenderMs',
    'medianCaptureMs',
    'realtimeFactor',
  ],
  pctInverse: ['encodeFps'],
  pctThreshold: 10,
  abs: [
    ['homeRendersPerSec', 1],
    ['pausedRendersPerSec', 1],
  ],
}

// ── args ──────────────────────────────────────────────────────────────────

const HELP = `midee perf harness - see docs/BENCH_HARNESS_V2_2026-07-02.md

usage: npm run bench [-- <flags>]        build (${OUT_DIR}/) + run
       npm run bench:run [-- <flags>]    run against existing ${OUT_DIR}/
       npm run bench:real [-- <flags>]   build + exportreal in real Chrome + Safari

  --suite a,b,c     suites: frame, attribution, live, idle, pacing, export,
                    exportlab, exportreal, exportstages, encodemax, encodepar,
                    exportquality, audiorender, headroom, voiceload
                    (default: frame,attribution,live,idle)
                    export = replica of the export loop (per-frame costs)
                    exportreal = the shipped VideoExporter end to end (audio
                    + video + mux, first 20 s of the piece; use --browser)
                    exportquality = encoder knobs through the real exporter
                    on deterministic frames: size, PSNR/SSIM vs the render,
                    frame/pts/keyframe structure, A/V sync; MP4s saved to
                    bench/exports/ (real-browser mode)
                    headroom = offline pre-clip peak per instrument on held
                    clusters (synthetic fixtures: cluster-ff, cluster-mf,
                    stack-185, pedal-piece)
  --fixture x,y     fixture ids (default: all - sparse → dense)
  --instruments a,b audio suites only: instrument ids (default: all 13;
                    'piano' downloads samples from an external CDN)
  --protection off  headroom only: bypass the master bus's soft-clip ceiling
                    to read raw instrument levels (for setting trims)
  --res a,b         export-size suites: 720p, 1080p, 4k (default 1080p)
  --fps a,b         export-size suites: 30, 60 (default 30)
                    export-size suites: exportreal, exportlab (capture/encoder
                    knob sweep), exportstages (per-stage ms + GPU drain per
                    effect config), encodemax (encoder ceiling on pre-rendered
                    frames), encodepar (1-4 parallel encoders, main vs worker)
  --overlay a,b     exportreal only: what covers the canvas during the export —
                    none (default), modal (the export dialog's blurred scrim, as
                    shipped), opaque (same scrim, no blur), bare (only the canvas)
  --configs a,b     exportstages: subset of base, filterglow, noparticles, noglow,
                    labels, bare, glass; exportquality: subset of hw-rt, hw-q,
                    sw-rt, sw-eq (default all; Safari ignores sw, so hw-rt,hw-q
                    there)
  --glow filter|baked
                    note-glow path for every suite (default baked, as shipped
                    since 2026-09-28 — src/renderer/bakedGlow.ts; filter = the
                    old GlowFilter). filter results key their own baseline
                    rows (+glow-filter)
  --cold hw|sw      encodemax only: which encoder the cold-start probe opens
                    the page with (default hw)
  --hw hw|sw        exportstages only: encode with prefer-hardware (default,
                    as shipped) or prefer-software
  --queue N         exportstages only: backpressure depth (default 2, as shipped)
  --variants a,b    exportlab only: run just these variants, incl. the opt-in
                    queue sweep (q1, q2, q8, sw-q4, quality-q4)
  --quick           smoke mode: frame+idle, sparsest+densest fixture, 1 run
  --runs N          repeats per suite, best run wins (default 2); sweep suites
                    (exportlab, exportstages, encodemax, encodepar) report
                    the per-metric median; all runs go to bench/latest.json
  --timeout S       per-run timeout in seconds (default ${DEFAULT_TIMEOUT_S})

  --browser a,b     real-browser mode (macOS): chrome, chrome-iso, safari.
                    Opens each run in the real app (real GPU + hardware
                    encoder), collects results on a local sink (:${SINK_PORT}),
                    runs strictly one at a time and closes each tab after.
                    Runs never take focus; windows go to a secondary display
                    when one is attached.
                    chrome = a tab in your running Chrome (\`open -g -a\`);
                    chrome-iso = a dedicated second Chrome instance (own
                    profile in bench/, background-throttling off) — use it
                    whenever you keep browsing during the run; safari = a new
                    Safari window per run. Keep the machine idle. Runs where
                    the page was hidden are flagged (hiddenMs). First use may
                    ask to let the terminal control the browser (tab close).
                    Env key: real|<browser>-<major>|<chip>.

  --cpu N           CDP CPU throttle (4 ≈ mid-tier phone)
  --no-gpu          software raster - GPU cost becomes CPU-visible
  --dpr N           deviceScaleFactor emulation
  --viewport WxH    viewport emulation
  --device phone    preset: 390x844 @ dpr3, cpu 4×
  --device slow     preset: cpu 6×
  --headed          headed browser (required for the pacing suite)

  --update          merge results into bench/baseline.json for THIS env
  --json            machine-readable output (always also bench/latest.json)

Baselines are keyed by environment - numbers from different device profiles
are never compared. Gates: median/p95 frame ms and exportreal realtimeFactor
+10% vs baseline; encodeFps -10%; idle renders/sec ≤ 1 (absolute).`

function parseArgs(argv) {
  const args = {
    suites: DEFAULT_SUITES,
    suitesExplicit: false,
    fixtures: null, // null = all from page
    instruments: null, // null = all (audio suites)
    cpu: 1,
    noGpu: false,
    dpr: null,
    viewport: null,
    headed: false,
    runs: 2,
    runsExplicit: false,
    quick: false,
    update: false,
    json: false,
    browsers: null, // null = Playwright; else real-browser ids
    res: ['1080p'],
    fps: [30],
    overlay: ['none'],
    timeoutS: DEFAULT_TIMEOUT_S,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--help' || a === '-h') {
      console.log(HELP)
      process.exit(0)
    } else if (a === '--suite') {
      args.suites = next().split(',')
      args.suitesExplicit = true
    } else if (a === '--fixture') args.fixtures = next().split(',')
    else if (a === '--instruments') args.instruments = next().split(',')
    else if (a === '--protection') {
      const v = next()
      if (v !== 'on' && v !== 'off') die(`--protection expects on|off, got ${v}`)
      args.protectionOff = v === 'off'
    }
    else if (a === '--cpu') args.cpu = Number(next())
    else if (a === '--no-gpu') args.noGpu = true
    else if (a === '--dpr') args.dpr = Number(next())
    else if (a === '--viewport') args.viewport = next()
    else if (a === '--headed') args.headed = true
    else if (a === '--runs') {
      args.runs = Math.max(1, Number(next()))
      args.runsExplicit = true
    } else if (a === '--quick') args.quick = true
    else if (a === '--update') args.update = true
    else if (a === '--json') args.json = true
    else if (a === '--browser') {
      args.browsers = next().split(',')
      for (const b of args.browsers) {
        if (!REAL_BROWSERS[b]) die(`unknown --browser ${b} (${Object.keys(REAL_BROWSERS).join('|')})`)
      }
    } else if (a === '--res') {
      args.res = next().split(',')
      for (const r of args.res) {
        if (!EXPORTREAL_RES.includes(r)) die(`--res expects ${EXPORTREAL_RES.join('|')}, got ${r}`)
      }
    } else if (a === '--fps') {
      args.fps = next().split(',').map(Number)
      for (const f of args.fps) {
        if (!EXPORTREAL_FPS.includes(f)) die(`--fps expects ${EXPORTREAL_FPS.join('|')}, got ${f}`)
      }
    } else if (a === '--overlay') {
      args.overlay = next().split(',')
      for (const o of args.overlay) {
        if (!EXPORT_OVERLAYS.includes(o)) die(`--overlay expects ${EXPORT_OVERLAYS.join('|')}, got ${o}`)
      }
    } else if (a === '--glow') {
      args.glow = next()
      if (args.glow !== 'filter' && args.glow !== 'baked') die(`--glow expects filter|baked, got ${args.glow}`)
    } else if (a === '--configs') args.configs = next()
    else if (a === '--variants') args.variants = next()
    else if (a === '--queue') args.queue = Math.max(1, Number(next()))
    else if (a === '--cold' || a === '--hw') {
      const v = next()
      if (v !== 'hw' && v !== 'sw') die(`${a} expects hw|sw, got ${v}`)
      args[a.slice(2)] = v
    }
    else if (a === '--timeout') args.timeoutS = Math.max(10, Number(next()))
    else if (a === '--device') {
      const preset = next()
      if (preset === 'phone') {
        args.viewport = '390x844'
        args.dpr = 3
        args.cpu = 4
      } else if (preset === 'slow') {
        args.cpu = 6
      } else {
        die(`unknown --device preset: ${preset} (phone|slow)`)
      }
    } else die(`unknown flag: ${a} (--help for usage)`)
  }
  if (args.quick) {
    // Smoke mode: the cheap early-warning loop. Explicit flags still win.
    if (!args.suitesExplicit) args.suites = ['frame', 'idle']
    if (!args.runsExplicit) args.runs = 1
  }
  if (args.suites.includes('pacing') && !args.headed && !args.browsers) {
    die('the pacing suite measures real rAF cadence - run it with --headed or --browser')
  }
  if (args.browsers) {
    if (process.platform !== 'darwin') die('--browser drives macOS apps via `open -a` - macOS only')
    if (args.cpu !== 1 || args.noGpu || args.dpr || args.viewport || args.headed) {
      die('--browser runs the real app as-is: --cpu/--no-gpu/--dpr/--viewport/--device/--headed are Playwright emulation flags')
    }
  }
  return args
}

function envKey(args) {
  const parts = [
    `cpu${args.cpu}x`,
    args.noGpu ? 'gpu-off' : 'gpu-on',
    `dpr${args.dpr ?? 'native'}`,
    args.viewport ?? 'default-vp',
    args.headed ? 'headed' : 'headless',
  ]
  return parts.join('|')
}

// Real-browser env: version from the UA the page reported (the build actually
// running — Chrome can have a newer one staged on disk), chip from sysctl.
function realEnvKey(id, ua) {
  const major = REAL_BROWSERS[id].version.exec(ua ?? '')?.[1] ?? 'unknown'
  const chip = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' })
  const chipSlug = (chip.stdout || 'unknown-cpu').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return `real|${id}-${major}|${chipSlug}`
}

function die(msg) {
  console.error(msg)
  process.exit(1)
}

// For failures once servers are up: thrown so main's finally still tears
// them down, printed without a stack.
class BenchError extends Error {}

// ── browser plumbing ──────────────────────────────────────────────────────

async function launch(args) {
  const launchArgs = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--enable-precise-memory-info',
  ]
  if (args.noGpu) launchArgs.push('--disable-gpu')
  return chromium.launch({ headless: !args.headed, args: launchArgs })
}

async function newPage(browser, args) {
  const ctxOpts = {}
  if (args.viewport) {
    const [w, h] = args.viewport.split('x').map(Number)
    ctxOpts.viewport = { width: w, height: h }
  }
  if (args.dpr) ctxOpts.deviceScaleFactor = args.dpr
  const context = await browser.newContext(ctxOpts)
  // Headed runs would otherwise show the Web MIDI prompt the app fires on boot.
  await context.grantPermissions(['midi', 'midi-sysex']).catch(() => {})
  const page = await context.newPage()
  page.on('pageerror', (err) => console.error(`  [page error] ${err.message}`))
  page.on('crash', () => console.error('  [page CRASHED]'))
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) console.error(`  [navigated] ${frame.url()}`)
  })
  page.on('console', (msg) => {
    const text = msg.text()
    // Surface render-backend degradation (context loss, software fallback).
    if (/webgl|gpu|context lost|swiftshader/i.test(text)) console.error(`  [page ${msg.type()}] ${text}`)
  })
  if (args.cpu > 1) {
    const session = await context.newCDPSession(page)
    await session.send('Emulation.setCPUThrottlingRate', { rate: args.cpu })
  }
  return { context, page }
}

async function runInPage(browser, args, query) {
  const { context, page } = await newPage(browser, args)
  try {
    await page.goto(`http://localhost:${PORT}/?${query}`, { waitUntil: 'load' })
    let handle
    try {
      handle = await page.waitForFunction(
        () =>
          window.__BENCH_RESULT ||
          window.__BENCH_FIXTURES ||
          (window.__BENCH_ERROR && { __err: window.__BENCH_ERROR }),
        null,
        { timeout: args.timeoutS * 1000 },
      )
    } catch (err) {
      // Timeout — surface where the in-page runner got stuck, plus a live
      // delivery probe: do timers / rAF / MessageChannel still fire?
      const state = await page
        .evaluate(
          () =>
            new Promise((res) => {
              const out = {
                progress: window.__BENCH_PROGRESS,
                error: window.__BENCH_ERROR,
                vis: document.visibilityState,
                timer: false,
                raf: false,
                msg: false,
              }
              setTimeout(() => {
                out.timer = true
              }, 50)
              requestAnimationFrame(() => {
                out.raf = true
              })
              const mc = new MessageChannel()
              mc.port1.onmessage = () => {
                out.msg = true
              }
              mc.port2.postMessage(1)
              setTimeout(() => res(out), 400)
            }),
        )
        .catch(() => null)
      throw new Error(
        `bench timed out on ?${query} - last progress: ${state?.progress ?? 'none'}${state?.error ? `, page error: ${state.error}` : ''}; delivery probe: ${state ? `vis=${state.vis} timer=${state.timer} raf=${state.raf} msg=${state.msg}` : 'unresponsive'}`,
        { cause: err },
      )
    }
    const value = await handle.jsonValue()
    if (value?.__err) throw new Error(`bench failed: ${value.__err}`)
    if (query === 'bench=list') {
      // The page publishes both lists before __BENCH_FIXTURES appears.
      const audio = await page.evaluate(() => window.__BENCH_AUDIO_FIXTURES ?? [])
      return { midi: value, audio }
    }
    return value
  } finally {
    await context.close()
  }
}

// ── targets: where a run happens ──────────────────────────────────────────
// `run(query)` resolves the page's BenchResult, or `{ midi, audio }` for
// `bench=list`. `env` is the baseline-key prefix (known once the target has
// answered one run — real browsers report their own version).

async function playwrightTarget(args) {
  const browser = await launch(args)
  return {
    name: 'playwright',
    env: envKey(args),
    run: (query) => runInPage(browser, args, query),
    close: () => browser.close(),
  }
}

function realTarget(id, sink, args) {
  const target = {
    name: id,
    env: null,
    run: async (query) => {
      const msg = await runReal(id, sink, query, args.timeoutS)
      target.env ??= realEnvKey(id, msg.ua)
      return msg.kind === 'list' ? { midi: msg.midi, audio: msg.audio } : msg.result
    },
    close: async () => {
      if (id === 'chrome-iso') quitIsoChrome()
    },
  }
  return target
}

// Opens `url` for one run and returns how to close it again. Safari gets a
// new window rather than a tab (a tab in the user's window goes hidden the
// moment they switch tabs); chrome-iso a tab in its own instance.
async function openReal(id, url, token) {
  const { app } = REAL_BROWSERS[id]
  if (id === 'chrome-iso') {
    await ensureIsoChrome()
    // Encoded: /json/new cuts a raw URL at its first `&`.
    const res = await fetch(`http://127.0.0.1:${ISO_CHROME.port}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    })
    if (!res.ok) throw new Error(`DevTools /json/new answered ${res.status}`)
    const { id: tabId } = await res.json()
    return () => fetch(`http://127.0.0.1:${ISO_CHROME.port}/json/close/${tabId}`).catch(() => {})
  }
  if (id === 'safari') {
    // No `activate`: the window opens on benchWindow()'s screen without focus.
    const win = benchWindow()
    const script = [
      'tell application "Safari"',
      `  make new document with properties {URL:"${url}"}`,
      ...(win ? [`  set bounds of front window to {${win.x}, ${win.y}, ${win.x + win.w}, ${win.y + win.h}}`] : []),
      'end tell',
    ].join('\n')
    await execFileAsync('osascript', ['-e', script])
  } else {
    await execFileAsync('open', ['-g', '-a', app, url])
  }
  return () => closeTabs(app, token)
}

// ── isolated Chrome (`--browser chrome-iso`) ─────────────────────────────
async function isoDevtoolsUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${ISO_CHROME.port}/json/version`)
    return res.ok
  } catch {
    return false
  }
}

async function ensureIsoChrome() {
  if (await isoDevtoolsUp()) return
  mkdirSync(ISO_CHROME.profile, { recursive: true })
  const win = benchWindow()
  spawnSync('open', [
    '-gna', // -g: launch without taking focus
    'Google Chrome',
    '--args',
    `--user-data-dir=${ISO_CHROME.profile}`,
    `--remote-debugging-port=${ISO_CHROME.port}`,
    ...ISO_CHROME.flags,
    ...(win ? [`--window-position=${win.x},${win.y}`, `--window-size=${win.w},${win.h}`] : []),
    'about:blank',
  ])
  cleanups.push(quitIsoChrome)
  for (let i = 0; i < 100; i++) {
    if (await isoDevtoolsUp()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new BenchError('chrome-iso: the isolated Chrome never opened its DevTools port')
}

// The instance's browser process: the one launched with our profile that
// isn't a `--type=` helper.
function isoChromePid() {
  const ps = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).stdout ?? ''
  for (const line of ps.split('\n')) {
    if (line.includes(`--user-data-dir=${ISO_CHROME.profile}`) && !line.includes('--type=')) {
      return Number(line.trim().split(/\s+/)[0])
    }
  }
  return null
}

function quitIsoChrome() {
  const pid = isoChromePid()
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

// One run in a real browser: open the URL in the app, wait for the page's
// POST, close the tab. The token ties the POST (and the tab) to this run, so
// a straggler from an earlier tab can't be mistaken for it.
async function runReal(id, sink, query, timeoutS) {
  const token = `bench${randomBytes(6).toString('hex')}`
  const report = `http://localhost:${SINK_PORT}/r/${token}`
  const url = `http://localhost:${PORT}/?${query}&report=${encodeURIComponent(report)}`
  const wait = sink.expect(token, timeoutS * 1000)
  let close = () => {}
  try {
    try {
      close = await openReal(id, url, token)
    } catch (err) {
      wait.cancel()
      throw new BenchError(`${id}: could not open the run - ${err.stderr || err.message}`)
    }
    let msg
    try {
      msg = await wait.done
    } catch {
      throw new BenchError(
        wait.slot.contacted
          ? `${id}: timed out after ${timeoutS}s on ?${query} - last progress: ${wait.slot.progress ?? 'none'} (keep the bench window visible - hidden tabs are throttled; --timeout raises the limit)`
          : `${id}: no word from the page after ${timeoutS}s on ?${query} - did the tab open http://localhost:${PORT} and load the bench build (${OUT_DIR}/)?`,
      )
    }
    if (msg.kind === 'error') {
      throw new BenchError(`${id}: bench failed: ${msg.error} (last progress: ${msg.progress ?? 'none'})`)
    }
    return msg
  } finally {
    await close()
  }
}

// Best effort: needs Automation permission for the terminal (macOS may ask
// once); a failure only leaves the tab open. Bounded so a pending permission
// dialog can't stall the matrix. Per-window loop on purpose: Chrome silently
// matches nothing for `every tab of every window whose …`.
function closeTabs(app, token) {
  const script = [
    `tell application "${app}"`,
    '  repeat with w in windows',
    `    close (every tab of w whose URL contains "${token}")`,
    '  end repeat',
    'end tell',
  ].join('\n')
  spawnSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 5000 })
}

// Local POST sink for real-browser runs: `POST /r/<token>` with the page's
// JSON (`kind`: progress | list | result | error), and `POST /f/<token>/<name>`
// with a file the page wants kept (written to EXPORTS_DIR; only for a live
// run's token, only plain `*.mp4` names). CORS `*` + OPTIONS so the
// cross-port POST works whatever the page sends.
const SINK_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

function startSink() {
  const slots = new Map()
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, SINK_CORS)
      res.end()
      return
    }
    const file = /^\/f\/(\w+)\/([^/]+)$/.exec(req.url ?? '')
    if (file) {
      let name = ''
      try {
        name = decodeURIComponent(file[2])
      } catch {
        // malformed escape → rejected below
      }
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const ok = req.method === 'POST' && slots.has(file[1]) && /^[\w.@+-]+\.mp4$/.test(name)
        if (ok) {
          mkdirSync(EXPORTS_DIR, { recursive: true })
          writeFileSync(resolve(EXPORTS_DIR, name), Buffer.concat(chunks))
        }
        res.writeHead(ok ? 204 : 404, SINK_CORS)
        res.end()
      })
      return
    }
    const token = /^\/r\/(\w+)$/.exec(req.url ?? '')?.[1]
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const ok = req.method === 'POST' && token
      res.writeHead(ok ? 204 : 404, SINK_CORS)
      res.end()
      const slot = ok && slots.get(token)
      if (!slot) return // stale tab from an earlier run
      let msg
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return
      }
      slot.contacted = true
      if (msg.kind === 'progress') slot.progress = msg.phase
      else slot.settle(msg)
    })
  })
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', (err) =>
      rejectPromise(new BenchError(`result sink could not listen on :${SINK_PORT} - ${err.message}`)),
    )
    server.listen(SINK_PORT, () =>
      resolvePromise({
        expect(token, timeoutMs) {
          const slot = { contacted: false, progress: null }
          const done = new Promise((ok, fail) => {
            const timer = setTimeout(() => {
              slots.delete(token)
              fail(new Error('timeout'))
            }, timeoutMs)
            slot.settle = (msg) => {
              clearTimeout(timer)
              slots.delete(token)
              ok(msg)
            }
            slot.cancel = () => {
              clearTimeout(timer)
              slots.delete(token)
            }
          })
          slots.set(token, slot)
          done.catch(() => {}) // a timeout before the caller awaits isn't "unhandled"
          return { done, slot, cancel: () => slot.cancel() }
        },
        close: () =>
          new Promise((r) => {
            server.closeAllConnections()
            server.close(() => r())
          }),
      }),
    )
  })
}

// Suites parameterised beyond the fixture: one entry per variant, the label
// appended to the fixture so each variant keys its own baseline row.
// --glow filter rides on every suite; 'baked' (shipped) keeps plain labels.
function variantsFor(suite, args) {
  const glow = args.glow === 'filter' ? { label: '+glow-filter', query: '&glow=filter' } : { label: '', query: '' }
  if (!RES_SUITES.has(suite)) return [glow]
  // exportreal × --overlay: 'none' keeps the plain label, so it compares
  // against the existing baseline row.
  const overlays = suite === 'exportreal' ? args.overlay : ['none']
  return args.res.flatMap((res) =>
    args.fps.flatMap((fps) =>
      overlays.map((ov) => ({
        label: `@${res}${fps}${ov === 'none' ? '' : `+${ov}`}${glow.label}`,
        query: `&res=${res}&fps=${fps}${ov === 'none' ? '' : `&overlay=${ov}`}${glow.query}`,
      })),
    ),
  )
}

// Repeat a suite `runs` times; keep the best run (lowest RUN_SCORE, default
// the frame median) - the standard noise-floor convention. Non-frame metrics
// come from that same winning run so the result stays internally consistent.
// Sweep suites (PIVOT_SUITES) are merged per metric instead. Either way every
// run's metrics ride along as `runs` (written to bench/latest.json).
async function runSuite(target, args, suite, fixture, variantQuery) {
  const audio = AUDIO_SUITES.has(suite)
  // Offline audio suites are deterministic — repeats only cost time.
  const runs = audio && !args.runsExplicit ? 1 : args.runs
  let query = `bench=${suite}&fixture=${fixture}${variantQuery}`
  if (audio && args.instruments) query += `&instruments=${args.instruments.join(',')}`
  if (audio && args.protectionOff) query += '&protection=off'
  if ((suite === 'exportstages' || suite === 'exportquality') && args.configs) {
    query += `&configs=${args.configs}`
  }
  if (suite === 'encodemax' && args.cold) query += `&cold=${args.cold}`
  if (suite === 'exportstages' && args.hw) query += `&hw=${args.hw}`
  if (suite === 'exportstages' && args.queue) query += `&queue=${args.queue}`
  if (suite === 'exportlab' && args.variants) query += `&variants=${args.variants}`
  const score = RUN_SCORE[suite] ?? ((m) => m.medianFrameMs ?? 0)
  let best = null
  const all = []
  for (let i = 0; i < runs; i++) {
    const result = await target.run(query)
    if (result.metrics.hiddenMs > 0) {
      console.log(
        `  ⚠ ${suite}/${fixture}${variantQuery}: page was hidden ${result.metrics.hiddenMs} ms - throttled timers, treat this run as invalid`,
      )
    }
    all.push(result.metrics)
    if (!best || score(result.metrics) < score(best.metrics)) best = result
  }
  const metrics = PIVOT_SUITES[suite] ? medianMetrics(all) : best.metrics
  return { ...best, metrics, runs: all }
}

// Per-key median across runs. Negative values are status codes (-1
// unsupported, -2 failed): a key that failed in any run keeps the code.
function medianMetrics(runs) {
  const out = {}
  for (const key of new Set(runs.flatMap((m) => Object.keys(m)))) {
    const values = runs.map((m) => m[key]).filter((v) => v !== undefined)
    const failed = values.find((v) => v < 0)
    if (failed !== undefined) {
      out[key] = failed
      continue
    }
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    out[key] = Math.round(median * 1000) / 1000
  }
  return out
}

// ── baseline ──────────────────────────────────────────────────────────────

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { schema: 2, entries: {} }
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  if (parsed.schema !== 2) {
    console.log('  (v1 baseline detected - ignored; run --update to write a v2 baseline)')
    return { schema: 2, entries: {} }
  }
  return parsed
}

function baselineKey(env, suite, fixture) {
  return `${env} :: ${suite} :: ${fixture}`
}

// ── compare + report ──────────────────────────────────────────────────────

function compare(metrics, baseMetrics) {
  const notes = []
  let regression = false
  for (const key of GATES.pct) {
    if (metrics[key] === undefined) continue
    const base = baseMetrics?.[key]
    if (base === undefined || base === 0) continue
    const delta = ((metrics[key] - base) / base) * 100
    const flag = delta >= GATES.pctThreshold ? '↑ REGRESSION' : delta <= -GATES.pctThreshold ? '↓ improved' : ''
    if (flag) notes.push(`${key} ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ${flag}`)
    if (delta >= GATES.pctThreshold) regression = true
  }
  for (const key of GATES.pctInverse) {
    if (metrics[key] === undefined) continue
    const base = baseMetrics?.[key]
    if (base === undefined || base === 0) continue
    const delta = ((metrics[key] - base) / base) * 100
    const flag = delta <= -GATES.pctThreshold ? '↓ REGRESSION' : delta >= GATES.pctThreshold ? '↑ improved' : ''
    if (flag) notes.push(`${key} ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}% ${flag}`)
    if (delta <= -GATES.pctThreshold) regression = true
  }
  for (const [key, limit] of GATES.abs) {
    if (metrics[key] !== undefined && metrics[key] > limit) {
      notes.push(`${key}=${metrics[key]} exceeds ${limit} - VIOLATION`)
      regression = true
    }
  }
  return { regression, notes }
}

// Per-suite table layout: which metrics become columns, in what order.
// Metrics not listed still land in bench/latest.json and --json output.
const SUITE_COLUMNS = {
  frame: [
    'medianFrameMs',
    'p95FrameMs',
    'p99FrameMs',
    'medianPresentMs',
    'heapGrowthMB',
    'noteCount',
  ],
  live: ['medianFrameMs', 'p95FrameMs', 'p99FrameMs', 'medianPresentMs'],
  attribution: [
    'medianFrameMs',
    'notesMsPerFrame',
    'keyboardMsPerFrame',
    'particlesMsPerFrame',
    'beatGridMsPerFrame',
    'liveNotesMsPerFrame',
    'otherMsPerFrame',
  ],
  idle: ['homeRendersPerSec', 'pausedRendersPerSec', 'playingRendersPerSec'],
  pacing: ['fps', 'droppedFramePct', 'p95IntervalMs', 'worstIntervalMs', 'longTasks'],
  export: [
    'medianRenderMs',
    'p95RenderMs',
    'medianCaptureMs',
    'p95CaptureMs',
    'encodeFps',
    'stallMs',
    'hwAccel',
  ],
  exportreal: [
    'wallMs',
    'realtimeFactor',
    'encodeFps',
    'videoEncodeMs',
    'audioRenderMs',
    'audioEncodeMs',
    'finalizeMs',
    'saveMs',
    'outputMB',
    'peakHeapMB',
    'hw',
    'opfs',
    'audioIncluded',
  ],
}

const COLUMN_LABELS = {
  wallMs: 'wall ms',
  realtimeFactor: '× realtime',
  videoEncodeMs: 'video ms',
  audioRenderMs: 'aud render',
  audioEncodeMs: 'aud enc',
  finalizeMs: 'finalize',
  saveMs: 'save',
  opfs: 'opfs',
  outputMB: 'MB',
  peakHeapMB: 'heap MB',
  hw: 'hw',
  audioIncluded: 'audio',
  medianFrameMs: 'median ms',
  p95FrameMs: 'p95',
  p99FrameMs: 'p99',
  medianPresentMs: 'present',
  heapGrowthMB: 'heapΔMB',
  noteCount: 'notes',
  notesMsPerFrame: 'notes',
  keyboardMsPerFrame: 'keyboard',
  particlesMsPerFrame: 'particles',
  beatGridMsPerFrame: 'beatGrid',
  liveNotesMsPerFrame: 'liveNotes',
  otherMsPerFrame: 'other',
  homeRendersPerSec: 'home r/s',
  pausedRendersPerSec: 'paused r/s',
  playingRendersPerSec: 'playing r/s',
  fps: 'fps',
  droppedFramePct: 'dropped %',
  p95IntervalMs: 'p95 int',
  worstIntervalMs: 'worst int',
  longTasks: 'longtasks',
  medianRenderMs: 'render ms',
  p95RenderMs: 'p95 rnd',
  medianCaptureMs: 'capture ms',
  p95CaptureMs: 'p95 cap',
  encodeFps: 'encode fps',
  stallMs: 'stall ms',
  hwAccel: 'hw',
}

function formatCell(key, value, baseMetrics) {
  if (value === undefined) return '-'
  let s = String(value)
  const base = baseMetrics?.[key]
  if ((GATES.pct.includes(key) || GATES.pctInverse.includes(key)) && base) {
    const d = ((value - base) / base) * 100
    const mark = d >= GATES.pctThreshold ? '↑' : d <= -GATES.pctThreshold ? '↓' : ''
    s += ` (${d >= 0 ? '+' : ''}${d.toFixed(0)}%)${mark}`
  }
  for (const [k, limit] of GATES.abs) {
    if (k === key && value > limit) s += ' ✗'
  }
  return s
}

// One table per env × suite; the env is named in the heading only when the
// run spanned several (real-browser mode with more than one --browser).
function printReport(results, baseline, args) {
  const envs = [...new Set(results.map((r) => r.env))]
  const bySuite = new Map()
  for (const r of results) {
    const group = `${r.env}\n${r.suite}`
    if (!bySuite.has(group)) bySuite.set(group, [])
    bySuite.get(group).push(r)
  }

  const unbaselined = new Set()
  let lastEnv = null
  for (const [group, rows] of bySuite) {
    const [env, suite] = group.split('\n')
    if (rows.some((r) => !baseline.entries[r.key])) unbaselined.add(env)
    if (envs.length > 1 && env !== lastEnv) console.log(`\n[${env}]`)
    lastEnv = env
    if (AUDIO_SUITES.has(suite)) {
      for (const r of rows) printAudioTable(suite, r)
      continue
    }
    if (PIVOT_SUITES[suite]) {
      for (const r of rows) printPivotTable(suite, r)
      continue
    }
    const cols = SUITE_COLUMNS[suite] ?? Object.keys(rows[0].result.metrics)
    const header = ['fixture', ...cols.map((c) => COLUMN_LABELS[c] ?? c)]
    const table = [header]
    for (const r of rows) {
      const base = baseline.entries[r.key]
      table.push([
        r.fixture + (base ? '' : ' *'),
        ...cols.map((c) => formatCell(c, r.result.metrics[c], base?.metrics)),
      ])
    }
    const widths = header.map((_, i) => Math.max(...table.map((row) => row[i].length)))
    console.log(`\n■ ${suite}`)
    for (let ri = 0; ri < table.length; ri++) {
      const line = table[ri]
        .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
        .join('   ')
      console.log(`  ${ri === 0 ? dim(line) : line}`)
    }
  }

  if (unbaselined.size && !args.update) {
    const envList = [...unbaselined].map((e) => `"${e}"`).join(', ')
    console.log(`\n* no baseline for env ${envList} - establish one:\n    ${updateCommand()}`)
  }
}

// This exact invocation, against the existing build, with --update.
function updateCommand() {
  const flags = process.argv
    .slice(2)
    .filter((a) => a !== '--update')
    .join(' ')
  return `npm run bench:run -- ${flags}${flags ? ' ' : ''}--update`
}

// Audio suites: one table per fixture, instruments as rows. Metric keys are
// `<instrument>_<metric>`; `peakDb > 0` is flagged — that's audible clipping
// in the online path.
function printAudioTable(suite, r) {
  const { metrics } = r.result
  const cols = AUDIO_METRICS[suite]
  const instruments = [...new Set(Object.keys(metrics).filter((k) => k.includes('_')).map((k) => k.split('_')[0]))]
  const header = ['instrument', ...cols]
  const table = [header]
  for (const inst of instruments) {
    table.push([
      inst,
      ...cols.map((m) => {
        const v = metrics[`${inst}_${m}`]
        if (v === undefined) return '-'
        const flag = (m === 'peakDb' && v > 0) || (m === 'firstDriftNote' && v > 0)
        return flag ? `${v} ✗` : String(v)
      }),
    ])
  }
  const widths = header.map((_, i) => Math.max(...table.map((row) => row[i].length)))
  const note =
    metrics.durationS !== undefined
      ? `${metrics.durationS}s held, protection ${metrics.protectionOn ? 'on' : 'OFF'}`
      : `${metrics.notes} notes, ${metrics.stepMs} ms apart`
  console.log(`\n■ ${suite} / ${r.fixture}  (${note})`)
  for (let ri = 0; ri < table.length; ri++) {
    const line = table[ri]
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join('   ')
    console.log(`  ${ri === 0 ? dim(line) : line}`)
  }
}

// Sweep suites: one table per row, variants as rows, PIVOT_SUITES[suite] as
// columns. Keys without a `_` (width, fps, hw, …) go in the heading.
function printPivotTable(suite, r) {
  const { metrics } = r.result
  const cols = PIVOT_SUITES[suite]
  const keys = Object.keys(metrics)
  const variants = [...new Set(keys.filter((k) => k.includes('_')).map((k) => k.split('_')[0]))]
  const scalars = keys
    .filter((k) => !k.includes('_'))
    .map((k) => `${k}=${metrics[k]}`)
    .join(' ')
  const header = ['variant', ...cols]
  const table = [header]
  for (const v of variants) {
    table.push([v, ...cols.map((m) => String(metrics[`${v}_${m}`] ?? '-'))])
  }
  const widths = header.map((_, i) => Math.max(...table.map((row) => row[i].length)))
  console.log(`\n■ ${suite} / ${r.fixture}  (${scalars}; runs=${r.result.runs?.length ?? 1}, median)`)
  for (let ri = 0; ri < table.length; ri++) {
    const line = table[ri]
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join('   ')
    console.log(`  ${ri === 0 ? dim(line) : line}`)
  }
}

function dim(s) {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv)
  if (!existsSync(BENCH_DIR)) mkdirSync(BENCH_DIR, { recursive: true })
  if (!existsSync(resolve(ROOT, OUT_DIR, 'index.html'))) {
    die(`no ${OUT_DIR}/ - run \`npm run bench\` (builds first) or \`npm run bench:build\``)
  }

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      for (const fn of cleanups.splice(0)) {
        try {
          fn()
        } catch {
          // best effort on the way out
        }
      }
      process.exit(130)
    })
  }

  const server = await startPreview()
  cleanups.push(() => server.kill('SIGTERM'))
  let sink = null
  const targets = []
  const results = []
  let anyRegression = false

  try {
    if (args.browsers) {
      sink = await startSink()
      for (const id of args.browsers) targets.push(realTarget(id, sink, args))
    } else {
      targets.push(await playwrightTarget(args))
    }
    // Discovery doubles as each target's handshake: a real browser that
    // can't reach the page or the sink fails here, before any long run, and
    // reports the UA its env key is built from.
    const lists = []
    for (const target of targets) lists.push(await target.run('bench=list'))
    const { midi: allFixtures, audio: audioFixtures } = lists[0]
    let fixtures = args.fixtures ?? allFixtures
    if (args.quick && !args.fixtures) {
      // Smoke mode: cheapest early warning — the sparse floor + dense ceiling.
      fixtures = [allFixtures[0], allFixtures[allFixtures.length - 1]]
    }
    const known = [...allFixtures, ...audioFixtures]
    for (const f of fixtures) {
      if (!known.includes(f)) throw new BenchError(`unknown fixture ${f} - page offers: ${known.join(', ')}`)
    }
    // Audio suites take the synthetic list by default; an explicit --fixture
    // is filtered to whichever list applies to the suite at hand.
    const fixturesFor = (suite) => {
      if (AUDIO_SUITES.has(suite)) {
        if (SUITE_FIXED_FIXTURE[suite]) return [SUITE_FIXED_FIXTURE[suite]]
        const list = args.fixtures ? args.fixtures.filter((f) => audioFixtures.includes(f)) : audioFixtures
        if (!list.length) throw new BenchError(`${suite} needs an audio fixture: ${audioFixtures.join(', ')}`)
        return list
      }
      if (FIXTURE_INDEPENDENT.has(suite)) return [fixtures[fixtures.length - 1]]
      const list = fixtures.filter((f) => allFixtures.includes(f))
      if (!list.length) throw new BenchError(`${suite} needs a MIDI fixture: ${allFixtures.join(', ')}`)
      return list
    }
    const baseline = loadBaseline()

    // Strictly sequential: one target, suite, fixture, variant, run at a time.
    for (const target of targets) {
      const { env } = target
      if (!args.json) {
        console.log(`env: ${env}  (runs=${args.runs}${args.quick ? ', quick' : ''})`)
      }
      for (const suite of args.suites) {
        for (const fixture of fixturesFor(suite)) {
          for (const variant of variantsFor(suite, args)) {
            const label = fixture + variant.label
            const t0 = Date.now()
            const result = await runSuite(target, args, suite, fixture, variant.query)
            const key = baselineKey(env, suite, label)
            const base = baseline.entries[key]
            const { regression, notes } = compare(result.metrics, base?.metrics)
            anyRegression ||= regression
            results.push({ key, suite, fixture: label, env, result, notes, regression })
            if (!args.json) {
              const secs = ((Date.now() - t0) / 1000).toFixed(0)
              console.log(`  ${regression ? '⚠' : '✓'} ${suite}/${label}  ${secs}s`)
            }
          }
        }
      }
    }
    if (!args.json) printReport(results, baseline, args)

    const envs = [...new Set(results.map((r) => r.env))]
    const payload = {
      schema: 2,
      at: new Date().toISOString(),
      env: envs.join(', '),
      results: results.map((r) => ({ key: r.key, ...r.result })),
    }
    writeFileSync(LATEST_PATH, JSON.stringify(payload, null, 2))

    if (args.update) {
      for (const r of results) {
        baseline.entries[r.key] = {
          at: payload.at,
          ua: r.result.env.ua,
          metrics: r.result.metrics,
        }
      }
      writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2))
      if (!args.json) console.log(`\nbaseline updated for env ${envs.map((e) => `"${e}"`).join(', ')} → bench/baseline.json`)
    }

    if (args.json) console.log(JSON.stringify(payload, null, 2))
    else if (!args.update) {
      if (anyRegression) {
        console.log('\n⚠  regressions:')
        for (const r of results) {
          const where = envs.length > 1 ? `[${r.env}] ` : ''
          for (const n of r.notes) console.log(`   ${where}${r.suite}/${r.fixture}: ${n}`)
        }
        console.log(`   accept intentionally: ${updateCommand()}`)
      } else if (results.some((r) => baseline.entries[r.key])) {
        console.log('\n✓  no regressions vs baseline for this env')
      }
    }
    if (anyRegression && !args.update) process.exitCode = 1
  } finally {
    for (const target of targets) await target.close().catch(() => {})
    await sink?.close()
    server.kill('SIGTERM')
  }
}

function startPreview() {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(
      'npx',
      ['vite', 'preview', '--outDir', OUT_DIR, '--port', String(PORT), '--strictPort'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] },
    )
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

main().catch((err) => {
  console.error(err instanceof BenchError ? err.message : err)
  process.exit(1)
})
