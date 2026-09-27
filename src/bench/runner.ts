// In-page bench runner — the measurement half of the perf harness.
// Driven by scripts/bench.mjs via URL params; see docs/BENCH_HARNESS_V2_2026-07-02.md.
//
// Protocol: `?bench=<suite>&fixture=<id>` runs one suite and publishes the
// result on `window.__BENCH_RESULT` (errors → `window.__BENCH_ERROR`).
// `?bench=list` publishes the fixture ids on `window.__BENCH_FIXTURES` so the
// driver discovers them from here — this file is the single source of truth.
// With `&report=<url>` (real-browser mode, `bench.mjs --browser`) the same
// list/result/error — plus throttled progress — is also POSTed there as JSON,
// since the driver can't read globals out of a tab it only `open -a`'d.
//
// Measurement rules this file enforces (the v1 harness broke both):
//   · CPU suites drive `renderManualFrame` under `pauseAutoRender()` — the
//     exact export code path — so the app ticker can't interleave frames and
//     headless rAF throttling is irrelevant.
//   · Frames are timed in batches of 10: `performance.now()` quantizes to
//     ~0.1 ms without cross-origin isolation, so single sub-ms frames are
//     mostly timer noise. A batch gives 0.01 ms/frame resolution. (Safari
//     quantizes to 1 ms: the export-stage suites report per-frame MEANS over
//     hundreds of frames, and `timerResMs` records the resolution seen.)
//
// Export-performance suites (docs/EXPORT_PERF_MEASUREMENTS_2026-09-27.md):
// `exportlab` (capture/encoder knob sweep), `exportstages` (where one export
// frame's time goes, per effect), `encodemax` (encoder ceiling on
// pre-rendered frames), `encodepar` (parallel encoders, main thread vs
// workers), `exportquality` (output size / fidelity / structure / A/V sync of
// encoder knobs through the real exporter). All take
// `&res=720p|1080p|4k&fps=30|60` like `exportreal`.
//
// `&glow=filter|baked` (+ `&glowTint=average|note`) picks the note-glow path
// for any suite (renderer/bakedGlow.ts); absent = the shipped default ('baked').

import { INSTRUMENTS, type InstrumentId, preloadSampleBuffers } from '../audio/instruments'
import { parseMidiFile } from '../core/midi/parser'
import type { MidiFile } from '../core/midi/types'
import { resolveExportBitrate, resolveExportRender, trimAudioBuffer } from '../export/exportMath'
import type { EncoderOverrides } from '../export/VideoExporter'
import { type GlowMode, glowSettings, setGlowMode } from '../renderer/bakedGlow'
import type { ParticleStyle } from '../renderer/particleStyles'
import { ALL_THEMES, type ThemeId } from '../renderer/theme'
import type { AppCtxValue } from '../store/AppCtx'
import type { ExportResolution } from '../ui/ExportModal'
import {
  type EncodeRunResult,
  type HwPref,
  overallFps,
  probeH264,
  runEncodeLoop,
  steadyFps,
  waitForDequeue,
  yieldNow,
} from './encodeLoop'
import type { EncodeWorkerReply } from './encodeWorker'

export interface BenchFixture {
  id: string
  url: string
}

// Ordered sparse → dense. The /local pieces are the stress end: fantaisie is
// fast+dense, kunst-der-fuge maximizes simultaneously-active notes.
export const BENCH_FIXTURES: readonly BenchFixture[] = [
  { id: 'bach-prelude-c', url: `${import.meta.env.BASE_URL}samples/bach-prelude-in-c.mid` },
  { id: 'satie-gnossienne-1', url: `${import.meta.env.BASE_URL}samples/satie-gnossienne-1.mid` },
  {
    id: 'chopin-nocturne-op9-2',
    url: `${import.meta.env.BASE_URL}samples/chopin-nocturne-op9-2.mid`,
  },
  {
    id: 'fantaisie-impromptu',
    url: `${import.meta.env.BASE_URL}local/002_f-f-chopin_fantaisie-impromptu.mid`,
  },
  {
    id: 'kunst-der-fuge',
    url: `${import.meta.env.BASE_URL}local/011_j-s-bach_die-kunst-der-fuge-contrapunctus-xv-canon-per-augmentationem.mid`,
  },
]

export type BenchSuite =
  | 'frame'
  | 'attribution'
  | 'live'
  | 'idle'
  | 'pacing'
  | 'export'
  | 'exportlab'
  | 'exportreal'
  | 'exportstages'
  | 'encodemax'
  | 'encodepar'
  | 'exportquality'
  | 'glowshots'
  | 'audiorender'
  | 'headroom'
  | 'voiceload'

export interface BenchEnv {
  ua: string
  cores: number
  dpr: number
  canvas: { width: number; height: number }
  webglRenderer: string
  automated: boolean
}

export interface BenchResult {
  schema: 2
  suite: BenchSuite
  fixture: string
  env: BenchEnv
  // Metric names/units are suite-specific; the driver treats them as an
  // opaque bag and formats/gates by key (see METRIC_GATES in bench.mjs).
  metrics: Record<string, number>
}

const DT = 1 / 60
const BATCH = 10
const WARMUP_BATCHES = 30

// ── stats helpers ─────────────────────────────────────────────────────────

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
  return sorted[Math.max(0, idx)]!
}

function summarize(perFrameMs: number[]): Record<string, number> {
  const sorted = [...perFrameMs].sort((a, b) => a - b)
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)
  return {
    medianFrameMs: round(quantile(sorted, 0.5)),
    p95FrameMs: round(quantile(sorted, 0.95)),
    p99FrameMs: round(quantile(sorted, 0.99)),
    meanFrameMs: round(mean),
    maxFrameMs: round(sorted[sorted.length - 1] ?? 0),
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Compositor-paced yield between samples. This is load-bearing, not
// politeness: driving `app.renderer.render()` in an unpaced tight loop
// overruns the (headless) compositor's pipeline — Chromium starts forcing
// synchronous GPU readbacks ("GPU stall due to ReadPixels") and batches
// intermittently crawl 100-1000× slower, which both poisons p95 and blows
// the driver timeout on long fixtures. One rAF per sample lets the
// compositor drain, keeps per-batch timing honest, and also flushes late
// async callbacks (GC, decode) outside the timed window.
function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

// Typed monkey-patch used by `attribution` and `idle`. Wraps a method with a
// timing/counting sink and returns an un-patch closure. Bench-only: product
// code is never shipped patched, and every patch is reverted in a finally.
type AnyMethod = (...args: unknown[]) => unknown
function patchMethod(obj: object, key: string, sink: (ms: number) => void): () => void {
  const target = obj as Record<string, AnyMethod>
  const orig = target[key]
  if (typeof orig !== 'function') throw new Error(`bench: cannot patch missing method ${key}`)
  target[key] = function (this: unknown, ...args: unknown[]) {
    const s = performance.now()
    const out = orig.apply(this, args)
    sink(performance.now() - s)
    return out
  }
  return () => {
    target[key] = orig
  }
}

// Renderer internals reached by the bench. Kept as a shape-cast (not `any`)
// so a rename in PianoRollRenderer fails the patch loudly at runtime here
// instead of silently timing nothing.
interface RendererInternals {
  noteRenderer: object
  liveNoteRenderer: object
  beatGrid: object
  keyboardRenderer: object
  particles: object
  app: { renderer: object }
}

function internals(renderer: object): RendererInternals {
  return renderer as unknown as RendererInternals
}

// ── environment capture ───────────────────────────────────────────────────

function captureEnv(ctx: AppCtxValue): BenchEnv {
  let webglRenderer = 'unknown'
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl')
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info')
    if (gl && dbg) {
      webglRenderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    }
  } catch {
    // leave 'unknown' — env capture must never fail a bench
  }
  const canvas = ctx.services.renderer.canvas
  return {
    ua: navigator.userAgent,
    cores: navigator.hardwareConcurrency ?? 0,
    dpr: window.devicePixelRatio || 1,
    canvas: { width: canvas.width, height: canvas.height },
    webglRenderer,
    automated: navigator.webdriver === true,
  }
}

// ── fixture loading ───────────────────────────────────────────────────────

async function loadFixture(ctx: AppCtxValue, id: string): Promise<MidiFile> {
  progress(`load:${id}`)
  const fixture = BENCH_FIXTURES.find((f) => f.id === id)
  if (!fixture) throw new Error(`unknown bench fixture: ${id}`)
  const res = await fetch(fixture.url)
  if (!res.ok) throw new Error(`fixture fetch failed: ${fixture.url} → ${res.status}`)
  const midi = await parseMidiFile(await res.arrayBuffer(), id)

  // Enter play mode through the store — <PlayMode/>'s effect then performs
  // the real surface side effects (renderer.loadMidi, trackPanel, title).
  // synth.load is deliberately NOT awaited/called: render benches must not
  // depend on instrument sample downloads.
  ctx.resetInteractionState()
  ctx.store.beginPlayLoad()
  ctx.services.renderer.clearMidi()
  ctx.store.completePlayLoad(midi)

  // Resume the AudioContext (no sound plays — no instrument is loaded). A
  // media-active page is exempt from browser backgrounding/throttling
  // heuristics in long headless runs, and it matches the app's state during
  // real playback. The driver passes --autoplay-policy=no-user-gesture-required.
  ctx.primeInteractiveAudio()

  // Let the app's idle-time warmups (piano-sample fetch + decode, modal chunk
  // prefetch, LearnController import) finish before measuring — they fire
  // ~200ms after boot and would otherwise land inside timed batches as
  // 100ms+ outliers that poison p95/max.
  progress(`settle:${id}`)
  await sleep(3000)
  return midi
}

function progress(phase: string): void {
  window.__BENCH_PROGRESS = phase
  // Real-browser mode: the driver's only window into a stuck run. Throttled
  // so a per-frame progress call never turns into per-frame network traffic.
  const now = performance.now()
  if (reportUrl && now - lastProgressPost >= 1000) {
    lastProgressPost = now
    void postReport({ kind: 'progress', phase })
  }
}

// `&report=<url>` sink (see header). Loopback only — a bench build must never
// beacon anywhere else, whatever URL it was opened with.
let reportUrl: string | null = null
let lastProgressPost = Number.NEGATIVE_INFINITY

function initReport(params: URLSearchParams): void {
  const raw = params.get('report')
  if (!raw) return
  try {
    const url = new URL(raw)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') reportUrl = url.href
  } catch {
    // malformed → no reporting; the driver times out with "no contact"
  }
}

// A string body keeps this a CORS "simple request" (text/plain, no
// preflight); the driver's sink answers OPTIONS anyway. `ua` rides along so
// the driver can key the env on the browser version actually running.
function postReport(body: Record<string, unknown>): Promise<void> {
  if (!reportUrl) return Promise.resolve()
  return fetch(reportUrl, {
    method: 'POST',
    body: JSON.stringify({ ...body, ua: navigator.userAgent }),
  }).then(
    () => {},
    (err: unknown) => console.warn('[bench] report POST failed', err),
  )
}

// Sweep positions across the meat of the piece — skip the sparse head and the
// fade-out tail so density reflects actual playback.
function sweepTimes(duration: number, samples: number): number[] {
  const start = duration * 0.25
  const end = duration * 0.95
  const step = (end - start) / Math.max(1, samples - 1)
  return Array.from({ length: samples }, (_, i) => start + i * step)
}

// ── suites ────────────────────────────────────────────────────────────────

// One timed batch: BATCH consecutive CPU scene updates from `t` (advancing by
// DT, the export call pattern) plus ONE real GPU present, timed separately.
// The split is deliberate: update cost is deterministic, app-controlled CPU
// work — the gated regression metric. Present cost is compositor/GPU-pipeline
// dependent (and pathological under headless GL when over-driven: full-rate
// presents intermittently stall 100-1000× on "GPU stall due to ReadPixels"),
// so it's reported as environment info, one present per batch.
interface BatchSample {
  updateMs: number
  presentMs: number
}
function timeBatch(ctx: AppCtxValue, t: number): BatchSample {
  const renderer = ctx.services.renderer
  const s0 = performance.now()
  for (let f = 0; f < BATCH; f++) {
    renderer.renderManualFrame(t + f * DT, DT, false)
  }
  const s1 = performance.now()
  renderer.renderManualFrame(t + BATCH * DT, DT)
  const s2 = performance.now()
  return { updateMs: (s1 - s0) / BATCH, presentMs: s2 - s1 }
}

function summarizeBatches(samples: BatchSample[]): Record<string, number> {
  const presents = samples.map((s) => s.presentMs).sort((a, b) => a - b)
  return {
    ...summarize(samples.map((s) => s.updateMs)),
    medianPresentMs: round(quantile(presents, 0.5)),
    p95PresentMs: round(quantile(presents, 0.95)),
  }
}

async function suiteFrame(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  const midi = await loadFixture(ctx, fixtureId)
  const renderer = ctx.services.renderer
  renderer.pauseAutoRender()
  try {
    progress(`frame:warmup:${fixtureId}`)
    const times = sweepTimes(midi.duration, 300)
    for (const t of sweepTimes(midi.duration, WARMUP_BATCHES)) {
      timeBatch(ctx, t)
      await nextFrame()
    }

    progress(`frame:measure:${fixtureId}`)
    const heap0 = heapMB()
    const samples: BatchSample[] = []
    for (let i = 0; i < times.length; i++) {
      progress(`frame:measure:${fixtureId}:${i}/${times.length}:t=${times[i]!.toFixed(2)}`)
      samples.push(timeBatch(ctx, times[i]!))
      await nextFrame()
    }
    const heap1 = heapMB()
    return {
      ...summarizeBatches(samples),
      frames: times.length * BATCH,
      heapGrowthMB: round(Math.max(0, heap1 - heap0)),
      noteCount: midi.tracks.reduce((n, tr) => n + tr.notes.length, 0),
    }
  } finally {
    renderer.resumeAutoRender()
  }
}

const ATTRIBUTION_PARTS = [
  ['notes', 'noteRenderer', 'draw'],
  ['liveNotes', 'liveNoteRenderer', 'draw'],
  ['beatGrid', 'beatGrid', 'draw'],
  ['keyboard', 'keyboardRenderer', 'drawActiveKeys'],
  ['particles', 'particles', 'update'],
] as const

async function suiteAttribution(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  const midi = await loadFixture(ctx, fixtureId)
  const renderer = ctx.services.renderer
  const inner = internals(renderer)
  renderer.pauseAutoRender()

  const acc = new Map<string, number>()
  const bump = (key: string) => (ms: number) => acc.set(key, (acc.get(key) ?? 0) + ms)
  const unpatch: Array<() => void> = []
  try {
    for (const [label, objKey, method] of ATTRIBUTION_PARTS) {
      unpatch.push(patchMethod(inner[objKey], method, bump(label)))
    }

    progress(`attribution:warmup:${fixtureId}`)
    for (const t of sweepTimes(midi.duration, WARMUP_BATCHES)) {
      timeBatch(ctx, t)
      await nextFrame()
    }
    acc.clear()

    progress(`attribution:measure:${fixtureId}`)
    const SAMPLES = 150
    const samples: BatchSample[] = []
    for (const t of sweepTimes(midi.duration, SAMPLES)) {
      samples.push(timeBatch(ctx, t))
      await nextFrame()
    }
    // Parts run once per scene update: BATCH no-present updates + the one
    // present (which also updates) per batch.
    const frames = SAMPLES * (BATCH + 1)

    const metrics: Record<string, number> = summarizeBatches(samples)
    let partsTotal = 0
    for (const [label] of ATTRIBUTION_PARTS) {
      const ms = (acc.get(label) ?? 0) / frames
      metrics[`${label}MsPerFrame`] = round(ms)
      partsTotal += ms
    }
    metrics.otherMsPerFrame = round(Math.max(0, metrics.meanFrameMs! - partsTotal))
    return metrics
  } finally {
    for (const u of unpatch) u()
    renderer.resumeAutoRender()
  }
}

// Live-performance frame cost: scheduled MIDI + a rolling held chord fed
// through the real InputBus (trails + keyboard highlights) + particle bursts.
// Pitch cycle is deterministic — no RNG anywhere in the harness.
async function suiteLive(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  const midi = await loadFixture(ctx, fixtureId)
  const { renderer, clock, input } = ctx.services
  renderer.pauseAutoRender()

  const HELD = 6
  let nextPitch = 48
  const held: number[] = []
  const press = (t: number) => {
    const pitch = 48 + ((nextPitch++ - 48) % 36)
    held.push(pitch)
    input.emitNoteOn({ pitch, velocity: 0.8, clockTime: t }, 'midi')
    if (held.length > HELD) {
      const oldest = held.shift()!
      input.emitNoteOff({ pitch: oldest, velocity: 0, clockTime: t }, 'midi')
    }
  }

  try {
    const times = sweepTimes(midi.duration, 200)
    for (const t of sweepTimes(midi.duration, WARMUP_BATCHES)) {
      clock.seek(t)
      press(t)
      timeBatch(ctx, t)
      await nextFrame()
    }

    progress(`live:measure:${fixtureId}`)
    const samples: BatchSample[] = []
    for (const t of times) {
      // Anchor the clock so trail geometry (startTime vs render time) is
      // realistic, churn the chord, and burst particles like a real note-on.
      clock.seek(t)
      press(t)
      press(t)
      renderer.burstParticleAt(held[held.length - 1]!)
      samples.push(timeBatch(ctx, t))
      await nextFrame()
    }
    return { ...summarizeBatches(samples), frames: times.length * BATCH }
  } finally {
    for (const pitch of held) {
      input.emitNoteOff({ pitch, velocity: 0, clockTime: clock.currentTime }, 'midi')
    }
    renderer.resumeAutoRender()
  }
}

// Idle regression guard: counts REAL renders (app.renderer.render calls) per
// second in three app states. home/paused must converge to ~0 after the
// idle-stop grace window; playing is the sanity control.
async function suiteIdle(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  const renderer = ctx.services.renderer
  const inner = internals(renderer)
  const SETTLE_MS = 3000
  const WINDOW_MS = 4000

  let renders = 0
  const unpatch = patchMethod(inner.app.renderer, 'render', () => renders++)

  // Fixed wall-clock settles kept tripping the paused gate: IDLE_GRACE_FRAMES
  // (30) is frame-counted, and throttled rAF (headless ~15Hz, worse under
  // --cpu) stretches it past any constant we pick. Wait for quiescence
  // instead — 1s with zero renders. The cap keeps a real regression (renders
  // that never stop) from hanging; the window then counts it and fails the gate.
  const settleUntilQuiet = async (maxMs = 15000): Promise<void> => {
    const start = performance.now()
    let seen = renders
    let quietSince = performance.now()
    while (performance.now() - start < maxMs) {
      await sleep(250)
      if (renders !== seen) {
        seen = renders
        quietSince = performance.now()
      } else if (performance.now() - quietSince >= 1000) {
        return
      }
    }
  }

  const countWindow = async (): Promise<number> => {
    await settleUntilQuiet()
    renders = 0
    const s = performance.now()
    await sleep(WINDOW_MS)
    return renders / ((performance.now() - s) / 1000)
  }

  try {
    ctx.store.enterHome()
    const homeRendersPerSec = await countWindow()

    await loadFixture(ctx, fixtureId)
    ctx.services.clock.seek(30)
    const pausedRendersPerSec = await countWindow()

    ctx.services.clock.play()
    ctx.store.setState('status', 'playing')
    await sleep(SETTLE_MS)
    renders = 0
    const s = performance.now()
    await sleep(WINDOW_MS)
    const playingRendersPerSec = renders / ((performance.now() - s) / 1000)
    ctx.services.clock.pause()
    ctx.store.setState('status', 'paused')

    return {
      homeRendersPerSec: round(homeRendersPerSec),
      pausedRendersPerSec: round(pausedRendersPerSec),
      playingRendersPerSec: round(playingRendersPerSec),
    }
  } finally {
    unpatch()
  }
}

// Real-world pacing: rAF interval distribution + long tasks during actual
// playback. Only meaningful headed — the driver refuses to schedule it
// headless, where compositor scheduling makes rAF cadence fiction.
async function suitePacing(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  await loadFixture(ctx, fixtureId)
  const WINDOW_MS = 8000

  let longTasks = 0
  let longTaskMs = 0
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks++
        longTaskMs += e.duration
      }
    })
    observer.observe({ type: 'longtask', buffered: false })
  } catch {
    observer = null // longtask unsupported — report -1 below
  }

  ctx.services.clock.play()
  ctx.store.setState('status', 'playing')
  await sleep(500) // settle into steady state

  const deltas: number[] = []
  await new Promise<void>((done) => {
    let prev = performance.now()
    const start = prev
    const tick = (now: number) => {
      deltas.push(now - prev)
      prev = now
      if (now - start < WINDOW_MS) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })

  ctx.services.clock.pause()
  ctx.store.setState('status', 'paused')
  observer?.disconnect()

  const sorted = [...deltas].sort((a, b) => a - b)
  const median = quantile(sorted, 0.5)
  const dropped = deltas.filter((d) => d > median * 1.5).length
  return {
    fps: round(1000 / Math.max(0.001, median)),
    medianIntervalMs: round(median),
    p95IntervalMs: round(quantile(sorted, 0.95)),
    worstIntervalMs: round(sorted[sorted.length - 1] ?? 0),
    droppedFramePct: round((dropped / Math.max(1, deltas.length)) * 100),
    longTasks: observer ? longTasks : -1,
    longTaskMs: observer ? round(longTaskMs) : -1,
  }
}

// Export-loop cost: the REAL pipeline VideoExporter runs per frame -
// seek → scene update + GPU present → VideoFrame(canvas) capture →
// encoder.encode — including its backpressure strategy. This is the suite
// that answers "how fast does an export run on this device", which the
// frame suite (CPU update only) deliberately does not.
async function suiteExport(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('WebCodecs unavailable - export suite cannot run in this browser')
  }
  const midi = await loadFixture(ctx, fixtureId)
  const { renderer, clock } = ctx.services
  const canvas = renderer.canvas

  const FPS = 30
  const EXPORT_DT = 1 / FPS
  const FRAMES = 450 // 15 s of output video
  const BITRATE = 8_000_000
  const MAX_QUEUE = 2 // mirrors VideoExporter's backpressure constant
  const width = canvas.width & ~1
  const height = canvas.height & ~1

  // Same two-pass probe order as VideoExporter: hardware first, software next.
  let hwAccel = 1
  const config: VideoEncoderConfig = {
    codec: 'avc1.640028', // High 4.0 — comfortably covers any window-size canvas
    width,
    height,
    bitrate: BITRATE,
    framerate: FPS,
    hardwareAcceleration: 'prefer-hardware',
    latencyMode: 'realtime',
  }
  if (!(await VideoEncoder.isConfigSupported(config)).supported) {
    hwAccel = 0
    config.hardwareAcceleration = 'prefer-software'
    if (!(await VideoEncoder.isConfigSupported(config)).supported) {
      throw new Error('no H.264 encoder accepted by this browser for the export suite')
    }
  }

  let encoderError: Error | null = null
  const encoder = new VideoEncoder({
    output: () => {}, // chunks discarded — muxing isn't what we're measuring
    error: (e) => {
      encoderError ??= e as Error
    },
  })
  encoder.configure(config)

  renderer.pauseAutoRender()
  const renderMs: number[] = []
  const captureMs: number[] = []
  let stallMs = 0
  try {
    progress(`export:encode:${fixtureId}`)
    const t0 = midi.duration * 0.25 // skip the sparse head, like sweepTimes
    const keyEvery = FPS * 2
    const wallStart = performance.now()
    for (let i = 0; i < FRAMES; i++) {
      if (encoderError) throw encoderError
      const t = t0 + i * EXPORT_DT

      const r0 = performance.now()
      clock.seek(t)
      renderer.renderManualFrame(t, EXPORT_DT)
      const r1 = performance.now()
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i * 1_000_000) / FPS),
        visibleRect: { x: 0, y: 0, width, height },
        displayWidth: width,
        displayHeight: height,
      })
      const r2 = performance.now()
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 })
      frame.close()
      renderMs.push(r1 - r0)
      captureMs.push(r2 - r1)

      if (encoder.encodeQueueSize > MAX_QUEUE) {
        const s0 = performance.now()
        while (encoder.encodeQueueSize > MAX_QUEUE / 2) {
          if (encoderError) throw encoderError
          await sleep(0)
        }
        stallMs += performance.now() - s0
      }
      if (i % 30 === 29) progress(`export:encode:${fixtureId}:${i + 1}/${FRAMES}`)
    }
    await encoder.flush()
    if (encoderError) throw encoderError
    const wallMs = performance.now() - wallStart

    const renders = [...renderMs].sort((a, b) => a - b)
    const captures = [...captureMs].sort((a, b) => a - b)
    return {
      medianRenderMs: round(quantile(renders, 0.5)),
      p95RenderMs: round(quantile(renders, 0.95)),
      medianCaptureMs: round(quantile(captures, 0.5)),
      p95CaptureMs: round(quantile(captures, 0.95)),
      encodeFps: round(FRAMES / (wallMs / 1000)),
      stallMs: round(stallMs),
      hwAccel,
      frames: FRAMES,
    }
  } finally {
    if (encoder.state !== 'closed') encoder.close()
    renderer.resumeAutoRender()
  }
}

// ── exportlab: variant sweep for the export loop ───────────────────────────
// Answers "which knob moves encode throughput on THIS machine": capture path
// (VideoFrame(canvas) vs readPixels vs 2D copy vs ImageBitmap), encoder
// latencyMode / hardware preference, and backpressure strategy. Each variant
// runs the same frames on a fresh encoder; chunks are discarded.
//
// `&res=720p|1080p|4k` runs on the export's real canvas (the preset's render
// plan and bitrate, as exportreal); without it, the window-size canvas at
// 8 Mbps (the original behaviour). `&fps=` sets the frame step and encoder
// framerate. Codec = VideoExporter's ladder, first level accepted.
// Metrics: `<variant>_fps` (-1 unsupported, -2 failed, -3 starved: one
// backpressure wait ran LAB_STARVED_MS without the queue draining — seen with
// the `yield` poll in Chrome 154, whose scheduler.yield() continuations
// outrank the task that delivers the encoder's dequeue), `<variant>_stall` ms.

const LAB_STARVED_MS = 3000
class LabStarved extends Error {}

interface LabVariant {
  name: string
  latencyMode?: 'quality' | 'realtime'
  hw?: 'prefer-hardware' | 'prefer-software' | 'no-preference'
  capture: 'canvas' | 'canvas-discard' | 'readpixels' | '2d' | 'bitmap'
  maxQueue: number
  wait: 'timeout' | 'dequeue' | 'yield'
  bitrateMode?: 'constant' | 'variable'
  optIn?: boolean
}

const LAB_VARIANTS: LabVariant[] = [
  { name: 'base', capture: 'canvas', maxQueue: 20, wait: 'timeout' },
  { name: 'dequeue', capture: 'canvas', maxQueue: 20, wait: 'dequeue' },
  { name: 'yield', capture: 'canvas', maxQueue: 20, wait: 'yield' },
  { name: 'q4', capture: 'canvas', maxQueue: 4, wait: 'dequeue' },
  { name: 'q60', capture: 'canvas', maxQueue: 60, wait: 'dequeue' },
  { name: 'quality', capture: 'canvas', maxQueue: 20, wait: 'dequeue', latencyMode: 'quality' },
  { name: 'nopref', capture: 'canvas', maxQueue: 20, wait: 'dequeue', hw: 'no-preference' },
  { name: 'sw', capture: 'canvas', maxQueue: 20, wait: 'dequeue', hw: 'prefer-software' },
  { name: 'cbr', capture: 'canvas', maxQueue: 20, wait: 'dequeue', bitrateMode: 'constant' },
  { name: 'discard', capture: 'canvas-discard', maxQueue: 20, wait: 'dequeue' },
  { name: 'readpx', capture: 'readpixels', maxQueue: 20, wait: 'dequeue' },
  { name: 'copy2d', capture: '2d', maxQueue: 20, wait: 'dequeue' },
  { name: 'bitmap', capture: 'bitmap', maxQueue: 20, wait: 'dequeue' },
  // Queue-depth sweep (added after q4 beat the shipped depth of 20 by ~38 %
  // in Chrome, 2026-09-27). Opt in with `&variants=` — not in the default run.
  { name: 'q1', capture: 'canvas', maxQueue: 1, wait: 'dequeue', optIn: true },
  { name: 'q2', capture: 'canvas', maxQueue: 2, wait: 'dequeue', optIn: true },
  { name: 'q8', capture: 'canvas', maxQueue: 8, wait: 'dequeue', optIn: true },
  {
    name: 'sw-q4',
    capture: 'canvas',
    maxQueue: 4,
    wait: 'dequeue',
    hw: 'prefer-software',
    optIn: true,
  },
  {
    name: 'quality-q4',
    capture: 'canvas',
    maxQueue: 4,
    wait: 'dequeue',
    latencyMode: 'quality',
    optIn: true,
  },
]

// `&variants=a,b` runs just those (opt-in ones included); default = every
// variant not marked optIn.
function labVariants(): LabVariant[] {
  const only = new URLSearchParams(window.location.search).get('variants')?.split(',')
  if (!only) return LAB_VARIANTS.filter((v) => !v.optIn)
  const picked = LAB_VARIANTS.filter((v) => only.includes(v.name))
  if (picked.length === 0) throw new Error(`exportlab: no variant matches ${only.join(',')}`)
  return picked
}

async function suiteExportLab(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('WebCodecs unavailable - exportlab cannot run in this browser')
  }
  const { res, fps: FPS } = exportParams()
  const midi = await loadFixture(ctx, fixtureId)
  const { renderer, clock } = ctx.services
  const canvas = renderer.canvas
  const DT = 1 / FPS
  const FRAMES = 300
  const exportCanvas = res ? enterExportCanvas(ctx, res) : null
  if (!exportCanvas) renderer.pauseAutoRender()
  const width = canvas.width & ~1
  const height = canvas.height & ~1
  const bitrate = res ? resolveExportBitrate(res) : 8_000_000
  const t0 = midi.duration * 0.25
  const keyEvery = FPS * 2
  const out: Record<string, number> = { width, height, fps: FPS, timerResMs: timerResolutionMs() }

  const gl = pixiOf(renderer).app.renderer.gl
  const pixelBuf = new Uint8Array(width * height * 4)
  const off = new OffscreenCanvas(width, height)
  const ctx2d = off.getContext('2d')!

  try {
    progress('exportlab:encoder-warmup')
    const warmConfig = await probeH264({ width, height, fps: FPS, bitrate, hw: 'prefer-hardware' })
    if (warmConfig) out.coldLat = await warmEncoder(warmConfig, canvas, FPS)
    for (const v of labVariants()) {
      progress(`exportlab:${v.name}`)
      const probed = await probeH264({
        width,
        height,
        fps: FPS,
        bitrate,
        hw: v.hw ?? 'prefer-hardware',
      })
      const config: VideoEncoderConfig | null = probed && {
        ...probed,
        latencyMode: v.latencyMode ?? 'realtime',
        ...(v.bitrateMode ? { bitrateMode: v.bitrateMode } : {}),
      }
      if (!config || !(await VideoEncoder.isConfigSupported(config)).supported) {
        out[`${v.name}_fps`] = -1
        continue
      }
      let encoderError: Error | null = null
      let wake: (() => void) | null = null
      const encoder = new VideoEncoder({
        output: () => {},
        error: (e) => {
          encoderError ??= e as Error
        },
      })
      encoder.ondequeue = () => {
        wake?.()
      }
      encoder.configure(config)
      let stallMs = 0
      const wallStart = performance.now()
      try {
        for (let i = 0; i < FRAMES; i++) {
          if (encoderError) throw encoderError
          const t = t0 + i * DT
          clock.seek(t)
          renderer.renderManualFrame(t, DT)
          const timestamp = Math.round((i * 1_000_000) / FPS)
          let frame: VideoFrame
          switch (v.capture) {
            case 'canvas':
              frame = new VideoFrame(canvas, {
                timestamp,
                visibleRect: { x: 0, y: 0, width, height },
              })
              break
            case 'canvas-discard':
              frame = new VideoFrame(canvas, {
                timestamp,
                alpha: 'discard',
                visibleRect: { x: 0, y: 0, width, height },
              })
              break
            case 'readpixels': {
              if (!gl) throw new Error('no gl')
              gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuf)
              frame = new VideoFrame(pixelBuf, {
                format: 'RGBA',
                codedWidth: width,
                codedHeight: height,
                timestamp,
              })
              break
            }
            case '2d':
              ctx2d.drawImage(canvas, 0, 0)
              frame = new VideoFrame(off, { timestamp })
              break
            case 'bitmap': {
              const bmp = await createImageBitmap(canvas)
              frame = new VideoFrame(bmp, { timestamp })
              bmp.close()
              break
            }
          }
          encoder.encode(frame, { keyFrame: i % keyEvery === 0 })
          frame.close()

          if (encoder.encodeQueueSize > v.maxQueue) {
            const s0 = performance.now()
            while (encoder.encodeQueueSize > v.maxQueue / 2) {
              if (encoderError) throw encoderError
              // A wait that never lets the encoder's dequeue task run spins
              // here forever — bail out and report -3 instead of hanging.
              if (performance.now() - s0 > LAB_STARVED_MS) throw new LabStarved()
              if (v.wait === 'timeout') await sleep(0)
              else if (v.wait === 'yield') await yieldNow()
              else {
                // dequeue can be coalesced/missed; a short timer bounds the wait.
                await new Promise<void>((r) => {
                  const timer = setTimeout(r, 20)
                  wake = () => {
                    clearTimeout(timer)
                    r()
                  }
                })
              }
            }
            stallMs += performance.now() - s0
          }
        }
        await encoder.flush()
        if (encoderError) throw encoderError
        const wallMs = performance.now() - wallStart
        out[`${v.name}_fps`] = round(FRAMES / (wallMs / 1000))
        out[`${v.name}_stall`] = round(stallMs)
      } catch (err) {
        console.warn(`[exportlab] ${v.name} failed`, err)
        out[`${v.name}_fps`] = err instanceof LabStarved ? -3 : -2
      } finally {
        if (encoder.state !== 'closed') encoder.close()
      }
    }
  } finally {
    if (exportCanvas) exportCanvas.restore()
    else renderer.resumeAutoRender()
  }
  return out
}

// Pixi internals the export-stage suites reach: the GL context (forced GPU
// drains, timer queries, readPixels capture), the bare submit, the note
// glow container (no public glow toggle) and the current effect settings.
// Shape-cast like `internals()` so a rename fails loudly here.
interface PixiInternals {
  app: {
    renderer: { gl?: WebGL2RenderingContext; render(container: unknown): void }
    stage: unknown
  }
  noteRenderer: {
    glowContainer: { renderable: boolean }
    labels: { enabled: boolean }
  }
  particles: { style: ParticleStyle }
}

function pixiOf(renderer: object): PixiInternals {
  return renderer as unknown as PixiInternals
}

// Smallest observable performance.now() step (Chrome ~0.1 ms, Safari 1 ms
// without cross-origin isolation). Busy-waits at most ~20 ticks.
function timerResolutionMs(): number {
  let min = Number.POSITIVE_INFINITY
  for (let i = 0; i < 20; i++) {
    const a = performance.now()
    let b = a
    while (b === a) b = performance.now()
    min = Math.min(min, b - a)
  }
  return round(min)
}

// ── exportreal: the shipped exporter, end to end ───────────────────────────
// `export` above replicates the loop to time its micro-costs; this suite runs
// the REAL `VideoExporter.export()` wired the way `App.startExport` wires it —
// render plan + bitrate from exportMath, mode 'av', the offline audio
// producer overlapping the video loop, codec-plan fallback, finalize — and
// takes the MP4 through `deliver` instead of a download. It answers "how long
// does a user wait", per browser, which is why the driver's real-browser mode
// (`--browser chrome,safari`) exists: headless has no hardware encoder.
//
// URL params: `res` = 720p|1080p|4k (landscape; default 1080p), `fps` = 30|60
// (default 30). Only the first EXPORTREAL_CAP_S seconds are exported so runs
// are bounded and comparable across fixtures: the renderer keeps the full
// piece (frames 0..cap match a full export's), the audio renders the piece
// truncated at the cap. Instrument pinned to 'upright' (the new-visitor
// default, self-hosted samples), decoded before the clock starts.

type ExportPresetRes = Extract<ExportResolution, '720p' | '1080p' | '4k'>
const EXPORT_PRESET_RES: readonly ExportPresetRes[] = ['720p', '1080p', '4k']
const EXPORTREAL_CAP_S = 20
const EXPORTREAL_INSTRUMENT: InstrumentId = 'upright'

// `&res=` / `&fps=` for the export-size suites. `res` is null when absent —
// each suite picks its default (exportlab: the window canvas; others 1080p).
function exportParams(): { res: ExportPresetRes | null; fps: number } {
  const params = new URLSearchParams(window.location.search)
  const res = params.get('res')
  const fps = Number(params.get('fps') ?? 30)
  if (res !== null && !EXPORT_PRESET_RES.includes(res as ExportPresetRes)) {
    throw new Error(`bench: res must be ${EXPORT_PRESET_RES.join('|')}, got ${res}`)
  }
  if (fps !== 30 && fps !== 60) throw new Error(`bench: fps must be 30|60, got ${fps}`)
  return { res: res as ExportPresetRes | null, fps }
}

// Puts the renderer where App.startExport puts it for a landscape preset:
// clock paused, status 'exporting' (gates the clock subscribers — scrubber,
// milestones — off), ticker paused, canvas resized to the preset's render
// plan (resolveExportRender, the same call app.ts makes). Landscape presets
// only: exportFraming() is a no-op for them, so the viewport needs nothing
// else. `restore()` undoes it; call it from a finally.
function enterExportCanvas(
  ctx: AppCtxValue,
  res: ExportPresetRes,
): { width: number; height: number; restore(): void } {
  const { renderer, clock, store } = ctx.services
  const originalResolution = renderer.canvasSize.resolution
  const plan = resolveExportRender(res, {
    width: window.innerWidth,
    height: window.innerHeight,
    resolution: originalResolution,
  })
  clock.pause()
  store.setState('status', 'exporting')
  renderer.pauseAutoRender()
  renderer.resize(plan.logicalWidth, plan.logicalHeight, plan.resolution)
  const { width, height } = renderer.canvasSize
  return {
    width,
    height,
    restore: () => {
      renderer.resize(window.innerWidth, window.innerHeight, originalResolution)
      renderer.resumeAutoRender()
      clock.seek(0)
      store.setState('status', 'ready')
    },
  }
}

// `&overlay=` (exportreal only) reproduces what covers the canvas during a real
// export, which the bench otherwise lacks — the export dialog. Every frame
// changes the canvas, so anything with a backdrop-filter above it is re-blurred
// by the compositor on the same GPU the export uses.
//   none   — the page as the bench leaves it (HUD visible, no dialog); default
//   modal  — the dialog's scrim as shipped (main.css `#export-modal.open`:
//            rgba(4,4,10,.7) + blur(14px)) with a progress-phase card
//   opaque — the same scrim fully opaque, no blur (the candidate fix)
//   bare   — everything but the canvas hidden: the compositing upper bound
type ExportOverlay = 'none' | 'modal' | 'opaque' | 'bare'
const EXPORT_OVERLAYS: readonly ExportOverlay[] = ['none', 'modal', 'opaque', 'bare']

function applyExportOverlay(overlay: ExportOverlay, canvas: HTMLCanvasElement): () => void {
  if (overlay === 'none') return () => {}
  if (overlay === 'bare') {
    // Hide every sibling along the canvas's ancestor chain.
    const hidden: [HTMLElement, string][] = []
    for (let el: HTMLElement | null = canvas; el && el !== document.body; el = el.parentElement) {
      for (const sib of el.parentElement?.children ?? []) {
        if (sib !== el && sib instanceof HTMLElement) {
          hidden.push([sib, sib.style.visibility])
          sib.style.visibility = 'hidden'
        }
      }
    }
    return () => {
      for (const [el, v] of hidden) el.style.visibility = v
    }
  }
  const scrim = document.createElement('div')
  Object.assign(scrim.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '80',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: overlay === 'modal' ? 'rgba(4, 4, 10, 0.7)' : 'rgb(4, 4, 10)',
  })
  if (overlay === 'modal') {
    scrim.style.setProperty('backdrop-filter', 'blur(14px)')
    scrim.style.setProperty('-webkit-backdrop-filter', 'blur(14px)')
  }
  const card = document.createElement('div')
  card.className = 'export-card'
  card.dataset.phase = 'progress'
  Object.assign(card.style, { opacity: '1', transform: 'none', height: '180px' })
  scrim.append(card)
  document.body.append(scrim)
  return () => scrim.remove()
}

async function suiteExportReal(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  const overlay = (new URLSearchParams(window.location.search).get('overlay') ??
    'none') as ExportOverlay
  if (!EXPORT_OVERLAYS.includes(overlay)) {
    throw new Error(`bench: overlay must be ${EXPORT_OVERLAYS.join('|')}, got ${overlay}`)
  }
  const params = exportParams()
  const res = params.res ?? '1080p'
  const { fps } = params
  const full = await loadFixture(ctx, fixtureId)
  const [{ VideoExporter }, { renderAudioOffline }, { truncateMidi }] = await Promise.all([
    import('../export/VideoExporter'),
    import('../audio/OfflineAudioRenderer'),
    import('./audioFixtures'),
  ])
  const midi = full.duration > EXPORTREAL_CAP_S ? truncateMidi(full, EXPORTREAL_CAP_S) : full
  progress(`exportreal:samples:${EXPORTREAL_INSTRUMENT}`)
  await preloadSampleBuffers(EXPORTREAL_INSTRUMENT)

  const { renderer, clock, store, synth } = ctx.services
  const exportCanvas = enterExportCanvas(ctx, res)
  const { width, height } = exportCanvas

  const exporter = new VideoExporter(renderer.canvas)
  let glLost = false
  const onGlLost = (e: Event): void => {
    e.preventDefault()
    glLost = true
    exporter.cancel()
  }
  renderer.canvas.addEventListener('webglcontextlost', onGlLost)

  // `performance.memory` is Chrome-only and a snapshot per access (read it
  // fresh each sample). Real Chrome and the Playwright driver (which passes
  // --enable-precise-memory-info) report precise values; other Chromium
  // setups serve a coarse cached bucket — a flat line. Fewer than 3 distinct
  // samples = unusable → -1.
  const heap: number[] = []
  const sampleHeap = (): void => {
    const mb = heapMB() // 0 where unsupported
    if (mb > 0) heap.push(mb)
  }
  sampleHeap()
  const heapTimer = setInterval(sampleHeap, 250)

  let deliveredBytes = 0
  const removeOverlay = applyExportOverlay(overlay, renderer.canvas)
  try {
    progress(`exportreal:${fixtureId}@${res}${fps}+${overlay}`)
    const t0 = performance.now()
    const stats = await exporter.export({
      fps,
      duration: midi.duration,
      mode: 'av',
      filename: 'bench.mp4',
      bitrate: resolveExportBitrate(res),
      audio: async (report) =>
        trimAudioBuffer(
          await renderAudioOffline({
            midi,
            instrumentId: EXPORTREAL_INSTRUMENT,
            volume: store.state.volume,
            disabledTrackIds: synth.getDisabledTrackIds(),
            onProgress: report,
          }),
          midi.duration,
        ),
      onAudioUnavailable: (stage, err) =>
        console.warn(`[bench] exportreal lost audio (${stage})`, err),
      onSeek: (t) => clock.seek(t),
      onRenderFrame: (t, dt) => renderer.renderManualFrame(t, dt),
      onProgress: (stage, pct) => progress(`exportreal:${stage}:${Math.round(pct * 100)}%`),
      deliver: (blob) => {
        deliveredBytes = blob.size
      },
    })
    const wallMs = performance.now() - t0
    sampleHeap()
    if (deliveredBytes === 0) throw new Error('exportreal: exporter delivered no file')

    const heapPrecise = new Set(heap).size >= 3
    return {
      wallMs: Math.round(wallMs),
      videoEncodeMs: stats.videoEncodeMs,
      encodeFps: round(stats.framesEncoded / (Math.max(1, stats.videoEncodeMs) / 1000)),
      realtimeFactor: round(wallMs / 1000 / midi.duration),
      audioRenderMs: stats.audioRenderMs,
      audioEncodeMs: stats.audioEncodeMs,
      finalizeMs: stats.finalizeMs,
      outputMB: round(stats.outputBytes / 1_048_576),
      attempts: stats.attempts,
      hw: stats.hw === 'prefer-hardware' ? 1 : 0,
      audioIncluded: stats.audioIncluded ? 1 : 0,
      audioWasm: stats.audioEncoder === 'wasm' ? 1 : 0,
      peakHeapMB: heapPrecise ? round(Math.max(...heap)) : -1,
      // The same per-frame split export_completed reports from the field.
      renderMsPerFrame: round(stats.renderMs / Math.max(1, stats.framesEncoded)),
      captureMsPerFrame: round(stats.captureMs / Math.max(1, stats.framesEncoded)),
      stallMsPerFrame: round(stats.stallMs / Math.max(1, stats.framesEncoded)),
      firstChunkMs: stats.firstChunkMs ?? -1,
      frames: stats.framesEncoded,
      durationS: round(midi.duration),
      width,
      height,
      fps,
    }
  } catch (err) {
    if (glLost) throw new Error(`exportreal: WebGL context lost at ${res}`)
    throw err
  } finally {
    removeOverlay()
    clearInterval(heapTimer)
    renderer.canvas.removeEventListener('webglcontextlost', onGlLost)
    exportCanvas.restore()
  }
}

// ── exportquality: what an encoder knob costs in OUTPUT, not just speed ───
// Before shipping latencyMode 'quality' or Chrome's software encoder (both
// faster in exportlab), check the files: size, bitrate vs target, fidelity
// against the frames the renderer drew, frame/timestamp/keyframe structure,
// A/V sync — through the REAL VideoExporter. One page load per browser × res:
//
//   1. Deterministic frames. The look is pinned (exportstages 'base': sunset,
//      embers, glow, no labels) and Math.random is swapped for a seeded PRNG
//      around each renderManualFrame call only (classic particle styles draw
//      from it at emission; the offline audio render running alongside never
//      sees it). The keyboard grain is baked once per page, so it's shared.
//   2. Reference: the export's frames (t = i/fps from 0, the first
//      EXPORTQUALITY_CAP_S s) rendered without encoding; the luma of every
//      EXPORTQUALITY_SAMPLE_EVERY-th frame is kept at native resolution
//      (BT.709-weighted Y' of the canvas RGB — 20 planes ≈ 166 MB at 4K).
//      Rendered twice: `refPsnr` = min PSNR between the passes (99 =
//      bit-identical) proves the determinism the comparison rests on.
//   3. Per config, VideoExporter.export() as the app calls it (mode 'av',
//      upright audio, preset bitrate, encoder pre-warmed like the dialog does)
//      with the knobs from ExportOptions.encoderOverrides, same seed. `wall` /
//      `fps` come from these passes — nothing else runs in them. The MP4 is
//      POSTed to the driver's sink (→ bench/exports/) for ffprobe/AVFoundation.
//   4. Each MP4 is demuxed and decoded in-page (videoQuality.inspectMp4:
//      Mediabunny + the browser's decoder, frames drawn through the browser's
//      YUV→RGB honouring the file's colour tags) and scored on the same luma:
//      PSNR, 8×8 block SSIM, bias; plus packets vs ceil(duration × fps), pts =
//      i/fps in decode order (a decrease = B-frame reordering), first pts,
//      keyframes every 2 s, and the decoded audio onset vs the shipped config's.
//
// Configs (`&configs=` picks a subset — Safari ignores prefer-software):
//   hw-rt  shipped: prefer-hardware, realtime, preset bitrate
//   hw-q   prefer-hardware, latencyMode 'quality'
//   sw-rt  prefer-software, realtime, preset bitrate
//   sw-eq  prefer-software, bitrate aimed at hw-rt's actual video kbps (needs
//          hw-rt first; up to 2 proportional corrections while > 15 % off):
//          the equal-size quality comparison
// Metrics `<config>_<m>`: wall ms, fps (frames / video encode s), mb (file),
// kbps (video, actual) vs tgt (requested), psnr/psnrMin, ssim/ssimMin, bias,
// frames, ptsErr (max ms), reorders, keyOff, firstPts, onset (audio ms),
// onsetD (vs hw-rt), hw (1 = the hardware plan shipped), steps (sw-eq
// attempts; the last one is reported), saved (file stored).

const EXPORTQUALITY_CAP_S = 20 // = exportreal, so hw-rt's wall time is comparable
// 20 reference frames (166 MB of luma at 4K). Coprime with the 60/120-frame
// GOP so the samples spread over GOP positions: a stride of 30 made every
// other sample a keyframe, and encoders spend very differently on keyframes
// (latencyMode 'quality' 1.5–3× more), which skewed mean PSNR.
const EXPORTQUALITY_SAMPLE_EVERY = 31
const EXPORTQUALITY_SEED = 0x6d1dee
const EXPORTQUALITY_EQ_TOLERANCE = 0.15
const EXPORTQUALITY_EQ_MAX_STEPS = 3

interface QualityConfig {
  name: string
  overrides: EncoderOverrides
  bitrate: 'preset' | 'match-hw'
}

const QUALITY_CONFIGS: readonly QualityConfig[] = [
  {
    name: 'hw-rt',
    overrides: { hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime' },
    bitrate: 'preset',
  },
  {
    name: 'hw-q',
    overrides: { hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality' },
    bitrate: 'preset',
  },
  {
    name: 'sw-rt',
    overrides: { hardwareAcceleration: 'prefer-software', latencyMode: 'realtime' },
    bitrate: 'preset',
  },
  {
    name: 'sw-eq',
    overrides: { hardwareAcceleration: 'prefer-software', latencyMode: 'realtime' },
    bitrate: 'match-hw',
  },
]

// Renders the export's frames without encoding; keeps the luma of every
// `sampleEvery`-th frame. Read back in the same task as the render, while the
// WebGL drawing buffer is still intact.
async function renderQualityReference(
  ctx: AppCtxValue,
  frames: number,
  fps: number,
  width: number,
  height: number,
): Promise<Map<number, Uint8Array>> {
  const { renderer, clock } = ctx.services
  const { lumaFromRgba, mulberry32, withRandom } = await import('./videoQuality')
  renderer.pauseAutoRender() // clears particles + note tracking: same start as an export
  const random = mulberry32(EXPORTQUALITY_SEED)
  const scratch = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
  if (!scratch) throw new Error('exportquality: no 2D context for reference frames')
  const refs = new Map<number, Uint8Array>()
  const dt = 1 / fps
  for (let i = 0; i < frames; i++) {
    const t = i * dt
    clock.seek(t)
    withRandom(random, () => renderer.renderManualFrame(t, dt))
    if (i % EXPORTQUALITY_SAMPLE_EVERY === 0) {
      scratch.drawImage(renderer.canvas, 0, 0)
      refs.set(i, lumaFromRgba(scratch.getImageData(0, 0, width, height).data))
    }
    if (i % 10 === 9) await yieldNow()
  }
  return refs
}

// Stores an exported file through the driver's sink (`/f/<token>/<name>` next
// to the report URL → bench/exports/). False without a sink (headless).
async function saveExportFile(name: string, blob: Blob): Promise<boolean> {
  if (!reportUrl) return false
  try {
    const url = `${reportUrl.replace('/r/', '/f/')}/${encodeURIComponent(name)}`
    return (await fetch(url, { method: 'POST', body: blob })).ok
  } catch {
    return false
  }
}

function browserTag(): string {
  const ua = navigator.userAgent
  if (ua.includes('HeadlessChrome')) return 'headless'
  if (ua.includes('Chrome/')) return 'chrome'
  if (ua.includes('Safari/')) return 'safari'
  return 'other'
}

async function suiteExportQuality(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('WebCodecs unavailable - exportquality cannot run in this browser')
  }
  const { res: resParam, fps } = exportParams()
  const res = resParam ?? '1080p'
  const only = new URLSearchParams(window.location.search).get('configs')?.split(',')
  const configs = only ? QUALITY_CONFIGS.filter((c) => only.includes(c.name)) : QUALITY_CONFIGS
  if (configs.length === 0) throw new Error(`exportquality: no config matches ${only?.join(',')}`)

  const full = await loadFixture(ctx, fixtureId)
  const [{ VideoExporter }, { renderAudioOffline }, { truncateMidi }, warmup, vq] =
    await Promise.all([
      import('../export/VideoExporter'),
      import('../audio/OfflineAudioRenderer'),
      import('./audioFixtures'),
      import('../export/encoderWarmup'),
      import('./videoQuality'),
    ])
  const midi = full.duration > EXPORTQUALITY_CAP_S ? truncateMidi(full, EXPORTQUALITY_CAP_S) : full
  progress(`exportquality:samples:${EXPORTREAL_INSTRUMENT}`)
  await preloadSampleBuffers(EXPORTREAL_INSTRUMENT)

  const { renderer, clock, store, synth } = ctx.services
  const px = pixiOf(renderer)
  const before = {
    theme: renderer.currentTheme,
    particles: px.particles.style,
    labels: px.noteRenderer.labels.enabled,
    glow: px.noteRenderer.glowContainer.renderable,
  }
  const exportCanvas = enterExportCanvas(ctx, res)
  try {
    applyStageConfig(ctx, STAGE_CONFIGS[0]!, glowSettings().mode) // pinned look: 'base'
    const width = exportCanvas.width & ~1
    const height = exportCanvas.height & ~1
    const frames = Math.max(1, Math.ceil(midi.duration * fps))
    const keyEvery = Math.max(1, Math.round(fps * 2)) // VideoExporter's KEYFRAME_INTERVAL_SEC
    const presetBitrate = resolveExportBitrate(res)
    const out: Record<string, number> = {
      width,
      height,
      fps,
      expectedFrames: frames,
      durationS: round(midi.duration),
    }

    progress('exportquality:reference')
    const refs = await renderQualityReference(ctx, frames, fps, width, height)
    progress('exportquality:reference-check')
    const again = await renderQualityReference(ctx, frames, fps, width, height)
    let refPsnr = 99
    for (const [i, luma] of refs) refPsnr = Math.min(refPsnr, vq.psnr(luma, again.get(i)!))
    again.clear()
    out.refPsnr = round(refPsnr)
    out.samples = refs.size

    // The dialog pre-warms the encoder before any export (Chrome's cold start).
    await warmup.prewarmVideoEncoder()

    const audio = async (report: (pct: number) => void): Promise<AudioBuffer> =>
      trimAudioBuffer(
        await renderAudioOffline({
          midi,
          instrumentId: EXPORTREAL_INSTRUMENT,
          volume: store.state.volume,
          disabledTrackIds: synth.getDisabledTrackIds(),
          onProgress: report,
        }),
        midi.duration,
      )

    // One real export + its inspection.
    const runConfig = async (c: QualityConfig, bitrate: number) => {
      renderer.pauseAutoRender() // same start state as the reference
      const random = vq.mulberry32(EXPORTQUALITY_SEED)
      const exporter = new VideoExporter(renderer.canvas)
      let blob: Blob | null = null
      const t0 = performance.now()
      const stats = await exporter.export({
        fps,
        duration: midi.duration,
        mode: 'av',
        filename: 'bench.mp4',
        bitrate,
        audio,
        encoderOverrides: c.overrides,
        onAudioUnavailable: (stage, err) =>
          console.warn(`[bench] exportquality ${c.name} lost audio (${stage})`, err),
        onSeek: (t) => clock.seek(t),
        onRenderFrame: (t, dt) => vq.withRandom(random, () => renderer.renderManualFrame(t, dt)),
        onProgress: (stage, pct) =>
          progress(`exportquality:${c.name}:${stage}:${Math.round(pct * 100)}%`),
        deliver: (b) => {
          blob = b
        },
      })
      const wallMs = performance.now() - t0
      const file = blob as Blob | null
      if (!file) throw new Error(`exportquality: ${c.name} delivered no file`)
      progress(`exportquality:${c.name}:inspect`)
      const report = await vq.inspectMp4(file, { fps, keyEvery, width, height, refs })
      return { stats, wallMs, file, report }
    }

    const videoKbps: Record<string, number> = {}
    let shippedOnset: number | null = null
    const tag = `${browserTag()}-${fixtureId}-${res}${fps}`
    const stamp = Date.now().toString(36)
    for (const c of configs) {
      let bitrate = presetBitrate
      const hwKbps = videoKbps['hw-rt']
      if (c.bitrate === 'match-hw') {
        if (!hwKbps) {
          out[`${c.name}_mb`] = -1 // needs hw-rt earlier in the same page
          continue
        }
        // Both encoders undershoot the preset target on this content (the
        // hardware one by ~7×), so aim straight at hw-rt's ACTUAL rate, then
        // correct proportionally.
        bitrate = Math.round(hwKbps * 1000)
      }
      progress(`exportquality:${c.name}`)
      let r = await runConfig(c, bitrate)
      let steps = 1
      while (
        c.bitrate === 'match-hw' &&
        hwKbps &&
        steps < EXPORTQUALITY_EQ_MAX_STEPS &&
        Math.abs(r.report.videoKbps / hwKbps - 1) > EXPORTQUALITY_EQ_TOLERANCE
      ) {
        bitrate = Math.round((bitrate * hwKbps) / r.report.videoKbps)
        progress(`exportquality:${c.name}:step${steps + 1}`)
        r = await runConfig(c, bitrate)
        steps++
      }
      const { stats, wallMs, file, report } = r
      videoKbps[c.name] = report.videoKbps
      if (c.name === 'hw-rt') shippedOnset = report.audioOnsetMs
      const m = (k: string, v: number): void => {
        out[`${c.name}_${k}`] = round(v)
      }
      m('wall', wallMs)
      m('fps', stats.framesEncoded / (Math.max(1, stats.videoEncodeMs) / 1000))
      m('mb', file.size / 1_048_576)
      m('kbps', report.videoKbps)
      m('tgt', bitrate / 1000)
      m('psnr', report.psnrMean)
      m('psnrMin', report.psnrMin)
      m('ssim', report.ssimMean)
      m('ssimMin', report.ssimMin)
      m('bias', report.biasMean)
      m('frames', report.frames)
      m('ptsErr', report.ptsErrMaxMs)
      m('reorders', report.reorders)
      m('keyOff', report.keyOffCadence)
      m('firstPts', report.firstPtsMs)
      m('unmatched', report.unmatched)
      m('onset', report.audioOnsetMs ?? -1)
      m(
        'onsetD',
        report.audioOnsetMs !== null && shippedOnset !== null
          ? report.audioOnsetMs - shippedOnset
          : -1,
      )
      m('hw', stats.hw === 'prefer-hardware' ? 1 : 0)
      m('steps', steps)
      m('saved', (await saveExportFile(`${tag}-${c.name}-${stamp}.mp4`, file)) ? 1 : 0)
    }
    return out
  } finally {
    renderer.setTheme(before.theme)
    renderer.setParticleStyle(before.particles)
    renderer.setNoteLabels(before.labels)
    px.noteRenderer.glowContainer.renderable = before.glow
    exportCanvas.restore()
  }
}

// ── exportstages: where one export frame's time goes ──────────────────────
// Stage attribution for the shipped loop at a real preset size, per effect
// configuration. Two passes per config over the same frames (the export's
// contiguous t0 + i/fps steps, so particles evolve as in a real export):
//
//   loop — the VideoExporter loop replica: seek + scene update (CPU) → Pixi
//          submit (CPU side of the GL calls) → VideoFrame(canvas) → encode(),
//          backpressure at 20 → 10 via `dequeue`, yield every 10 frames.
//          Every stage timed; `stall` is time blocked on backpressure, `fps`
//          the loop's throughput (flush included), `steady` the encoder's
//          output rate once warm, `lat` ms from the first encode() to the
//          first chunk (encoder start-up). Chunks discarded (no mux).
//   sync — same frames, no encoder, each bracketed by 1-px gl.readPixels (a
//          full GPU drain) so GPU time becomes CPU-visible: drain after submit
//          = the frame's GPU cost (draws + filters + MSAA resolve), drain
//          after VideoFrame(canvas) = the capture's GPU-side copy. The idle
//          drain (readPixels with nothing queued, `syncRt`) is subtracted.
//          EXT_disjoint_timer_query_webgl2 times the submit on the GPU where
//          exposed (`gpuQuery`, -1 elsewhere).
//
// Configs price each effect against the new-visitor look — app.ts's store
// defaults, theme 'sunset' + particles 'embers' + labels off — pinned so
// browser profiles with different saved settings measure the same scene.
// `filterglow` is `base` with the old GlowFilter note glow (the shipped glow
// is baked since 2026-09-28); the other glow configs use the page's `&glow=`
// mode (default: shipped).
// `&configs=base,bare` runs a subset (e.g. for slow headless 4K); `&hw=sw`
// encodes with prefer-software instead of the product's prefer-hardware;
// `&queue=N` sets the loop's backpressure depth (default 2, as shipped).
// Metrics: `<config>_<stage>`, per-frame means in ms unless named fps.

interface StageConfig {
  name: string
  theme: ThemeId
  particles: ParticleStyle
  glow: boolean
  glowMode?: GlowMode // unset = the page's `&glow=` mode
  labels: boolean
}

const STAGE_CONFIGS: readonly StageConfig[] = [
  { name: 'base', theme: 'sunset', particles: 'embers', glow: true, labels: false },
  {
    name: 'filterglow',
    theme: 'sunset',
    particles: 'embers',
    glow: true,
    glowMode: 'filter',
    labels: false,
  },
  { name: 'noparticles', theme: 'sunset', particles: 'none', glow: true, labels: false },
  { name: 'noglow', theme: 'sunset', particles: 'embers', glow: false, labels: false },
  { name: 'labels', theme: 'sunset', particles: 'embers', glow: true, labels: true },
  { name: 'bare', theme: 'sunset', particles: 'none', glow: false, labels: false },
  // A shipping material theme: textured layers per note, no glow filter.
  { name: 'glass', theme: 'liquid-glass', particles: 'embers', glow: true, labels: false },
]
const STAGE_LOOP_FRAMES = 240
const STAGE_SYNC_FRAMES = 120
const STAGE_WARMUP_FRAMES = 20
const STAGE_MAX_QUEUE = 2 // VideoExporter's MAX_ENCODE_QUEUE; `&queue=N` overrides

interface TimerQueryExt {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

function applyStageConfig(ctx: AppCtxValue, c: StageConfig, pageGlow: GlowMode): void {
  const { renderer } = ctx.services
  const theme = ALL_THEMES.find((t) => t.id === c.theme)
  if (!theme) throw new Error(`exportstages: unknown theme ${c.theme}`)
  setGlowMode(c.glowMode ?? pageGlow)
  renderer.setTheme(theme)
  renderer.setParticleStyle(c.particles)
  renderer.setNoteLabels(c.labels)
  // No public glow switch: `renderable` survives NoteRenderer.draw, which
  // rewrites `visible` every frame. The glow copies are skipped; the notes
  // themselves still draw.
  pixiOf(renderer).noteRenderer.glowContainer.renderable = c.glow
  // Clears particles + active-note tracking so every config starts equal.
  renderer.pauseAutoRender()
}

// Opens (and discards) one encoder on the current canvas so the browser's
// encoder start-up — seconds for the first hardware encoder of a Chrome
// session (encodemax `cold-*`) — is paid outside the timed variants.
// Returns that first-output latency in ms.
async function warmEncoder(
  config: VideoEncoderConfig,
  canvas: HTMLCanvasElement,
  fps: number,
): Promise<number> {
  const frame = exportFrame(canvas, 0, canvas.width & ~1, canvas.height & ~1)
  try {
    const r = await runEncodeLoop({ config, pool: [frame], frames: 10, fps })
    return round((r.outTimes[0] ?? r.endMs) - r.startMs)
  } finally {
    frame.close()
  }
}

function exportFrame(
  canvas: HTMLCanvasElement,
  timestamp: number,
  width: number,
  height: number,
): VideoFrame {
  // Exactly VideoExporter's construction.
  return new VideoFrame(canvas, {
    timestamp,
    visibleRect: { x: 0, y: 0, width, height },
    displayWidth: width,
    displayHeight: height,
  })
}

async function stageLoopPass(
  ctx: AppCtxValue,
  config: VideoEncoderConfig,
  t0: number,
  frames: number,
  fps: number,
  maxQueue: number,
): Promise<Record<string, number>> {
  const { renderer, clock } = ctx.services
  const px = pixiOf(renderer)
  const canvas = renderer.canvas
  const width = canvas.width & ~1
  const height = canvas.height & ~1
  const dt = 1 / fps
  const keyEvery = Math.round(fps * 2)
  const outTimes: number[] = []
  let failure: Error | null = null
  const encoder = new VideoEncoder({
    output: () => {
      outTimes.push(performance.now())
    },
    error: (e) => {
      failure ??= e instanceof Error ? e : new Error(String(e))
    },
  })
  encoder.configure(config)
  let update = 0
  let submit = 0
  let capture = 0
  let encodeCall = 0
  let stall = 0
  let yielded = 0
  const start = performance.now()
  try {
    for (let i = 0; i < frames; i++) {
      if (failure) throw failure
      const t = t0 + i * dt
      const a = performance.now()
      clock.seek(t)
      renderer.renderManualFrame(t, dt, false)
      const b = performance.now()
      px.app.renderer.render(px.app.stage)
      const c = performance.now()
      const frame = exportFrame(canvas, Math.round((i * 1_000_000) / fps), width, height)
      const d = performance.now()
      encoder.encode(frame, { keyFrame: i % keyEvery === 0 })
      frame.close()
      const e = performance.now()
      update += b - a
      submit += c - b
      capture += d - c
      encodeCall += e - d
      if (encoder.encodeQueueSize > maxQueue) {
        while (encoder.encodeQueueSize > maxQueue / 2) {
          if (failure) throw failure
          await waitForDequeue(encoder)
        }
        stall += performance.now() - e
      } else if (i % 10 === 9) {
        await yieldNow()
        yielded += performance.now() - e
      }
    }
    const flushStart = performance.now()
    await encoder.flush()
    if (failure) throw failure
    const end = performance.now()
    const n = frames
    const accounted = update + submit + capture + encodeCall + stall + yielded
    return {
      update: update / n,
      submit: submit / n,
      capture: capture / n,
      encodeCall: encodeCall / n,
      stall: stall / n,
      yield: yielded / n,
      other: Math.max(0, flushStart - start - accounted) / n,
      flushMs: end - flushStart,
      fps: n / ((end - start) / 1000),
      steady: steadyFps([outTimes]),
      lat: (outTimes[0] ?? end) - start,
    }
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }
}

async function stageSyncPass(
  ctx: AppCtxValue,
  gl: WebGL2RenderingContext,
  timerExt: TimerQueryExt | null,
  t0: number,
  frames: number,
  fps: number,
): Promise<Record<string, number>> {
  const { renderer, clock } = ctx.services
  const px = pixiOf(renderer)
  const canvas = renderer.canvas
  const width = canvas.width & ~1
  const height = canvas.height & ~1
  const dt = 1 / fps
  const pixel = new Uint8Array(4)
  const drain = (): void => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
  const queries: WebGLQuery[] = []
  let rt = 0
  let gpu = 0
  let captureIdle = 0
  let captureGpu = 0
  for (let i = 0; i < frames; i++) {
    const t = t0 + i * dt
    drain()
    const a = performance.now()
    drain()
    const b = performance.now()
    clock.seek(t)
    renderer.renderManualFrame(t, dt, false)
    const query = timerExt ? gl.createQuery() : null
    if (query && timerExt) gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query)
    px.app.renderer.render(px.app.stage)
    if (query && timerExt) {
      gl.endQuery(timerExt.TIME_ELAPSED_EXT)
      queries.push(query)
    }
    const d = performance.now()
    drain()
    const e = performance.now()
    const frame = exportFrame(canvas, 0, width, height)
    const f = performance.now()
    drain()
    const g = performance.now()
    frame.close()
    rt += b - a
    gpu += e - d
    captureIdle += f - e
    captureGpu += g - f
    if (i % 10 === 9) await yieldNow()
  }
  const n = frames
  const rtMs = rt / n
  return {
    syncRt: rtMs,
    gpu: Math.max(0, gpu / n - rtMs),
    captureIdle: captureIdle / n,
    captureGpu: Math.max(0, captureGpu / n - rtMs),
    gpuQuery: await readTimerQueries(gl, timerExt, queries),
  }
}

// Mean GPU ms of the queries, or -1 (no extension, disjoint, or no results).
// WebGL withholds results until control returns to the event loop.
async function readTimerQueries(
  gl: WebGL2RenderingContext,
  ext: TimerQueryExt | null,
  queries: WebGLQuery[],
): Promise<number> {
  const last = queries[queries.length - 1]
  if (!ext || !last) return -1
  for (let tries = 0; tries < 20; tries++) {
    await sleep(16)
    if (gl.getQueryParameter(last, gl.QUERY_RESULT_AVAILABLE)) break
  }
  const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) === true
  let sum = 0
  let n = 0
  for (const q of queries) {
    if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      sum += Number(gl.getQueryParameter(q, gl.QUERY_RESULT)) / 1e6
      n++
    }
    gl.deleteQuery(q)
  }
  return disjoint || n === 0 ? -1 : sum / n
}

async function suiteExportStages(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('WebCodecs unavailable - exportstages cannot run in this browser')
  }
  const { res: resParam, fps } = exportParams()
  const res = resParam ?? '1080p'
  const only = new URLSearchParams(window.location.search).get('configs')?.split(',')
  const configs = only ? STAGE_CONFIGS.filter((c) => only.includes(c.name)) : STAGE_CONFIGS
  if (configs.length === 0) throw new Error(`exportstages: no config matches ${only?.join(',')}`)

  const midi = await loadFixture(ctx, fixtureId)
  const { renderer } = ctx.services
  const px = pixiOf(renderer)
  const gl = px.app.renderer.gl
  if (!gl || typeof gl.createQuery !== 'function') {
    throw new Error('exportstages: needs the renderer on WebGL2')
  }
  const before = {
    theme: renderer.currentTheme,
    particles: px.particles.style,
    labels: px.noteRenderer.labels.enabled,
    glow: px.noteRenderer.glowContainer.renderable,
    glowMode: glowSettings().mode,
  }
  const exportCanvas = enterExportCanvas(ctx, res)
  try {
    const width = exportCanvas.width & ~1
    const height = exportCanvas.height & ~1
    // VideoExporter's first plan: hardware-preferred, software if refused.
    // `&hw=sw` starts from prefer-software instead (Chrome's OpenH264 out-runs
    // VideoToolbox in encodemax — this prices the loop around it).
    const target = { width, height, fps, bitrate: resolveExportBitrate(res) }
    const params = new URLSearchParams(window.location.search)
    const swFirst = params.get('hw') === 'sw'
    const maxQueue = Math.max(1, Number(params.get('queue') ?? STAGE_MAX_QUEUE))
    let hw: HwPref = swFirst ? 'prefer-software' : 'prefer-hardware'
    let config = await probeH264({ ...target, hw })
    if (!config) {
      hw = 'prefer-software'
      config = await probeH264({ ...target, hw })
    }
    if (!config) throw new Error(`exportstages: no H.264 encoder for ${width}x${height}`)
    const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null
    const out: Record<string, number> = {
      width,
      height,
      fps,
      hw: hw === 'prefer-hardware' ? 1 : 0,
      queue: maxQueue,
      timerResMs: timerResolutionMs(),
      timerQuery: timerExt ? 1 : 0,
    }
    // Encoder start-up outside the timed configs: a browser session's first
    // hardware encoder pays seconds of start-up in Chrome (encodemax `cold-*`),
    // which would otherwise land on whichever config runs first.
    progress('exportstages:encoder-warmup')
    out.coldLat = await warmEncoder(config, renderer.canvas, fps)
    const t0 = midi.duration * 0.25
    for (const c of configs) {
      applyStageConfig(ctx, c, before.glowMode)
      // Shader compiles, glyph atlases, material textures: outside the timing.
      progress(`exportstages:${c.name}:warmup`)
      await stageSyncPass(ctx, gl, null, t0, STAGE_WARMUP_FRAMES, fps)
      renderer.pauseAutoRender()
      progress(`exportstages:${c.name}:loop`)
      const loop = await stageLoopPass(ctx, config, t0, STAGE_LOOP_FRAMES, fps, maxQueue)
      renderer.pauseAutoRender()
      progress(`exportstages:${c.name}:sync`)
      const sync = await stageSyncPass(ctx, gl, timerExt, t0, STAGE_SYNC_FRAMES, fps)
      for (const [k, v] of Object.entries({ ...loop, ...sync })) out[`${c.name}_${k}`] = round(v)
    }
    return out
  } finally {
    setGlowMode(before.glowMode)
    renderer.setTheme(before.theme)
    renderer.setParticleStyle(before.particles)
    renderer.setNoteLabels(before.labels)
    px.noteRenderer.glowContainer.renderable = before.glow
    exportCanvas.restore()
  }
}

// ── encodemax: the encoder's own ceiling ──────────────────────────────────
// Renders POOL_SIZE consecutive export frames once at the preset size, then
// encodes them in a cycle with NO rendering — per hardware preference
// (hw = prefer-hardware, nopref = no-preference, sw = prefer-software) ×
// frame source:
//   canvas — VideoFrame(canvas) snapshots, the product's source (GPU-backed
//            in real browsers, so any RGBA→YUV conversion or readback the
//            browser does on the way into the encoder is included)
//   i420 / nv12 — CPU planar YUV built once from the same pixels: the
//            encoder with the cheapest input it can get
// encodemax canvas vs exportstages loop fps = what render + capture +
// scheduling cost; canvas vs i420/nv12 = the browser's frame-conversion cost.
// Metrics per `<hw>-<src>` cell: `fps` (whole run), `steady` (warm output
// rate), `kbpf` (kB per frame — sanity), `dq` (dequeue events seen), `lat`
// (ms from first encode() to first output — encoder start-up); -1
// unsupported, -2 failed.

const POOL_SIZE = 8
const ENCODEMAX_FRAMES: Record<ExportPresetRes, number> = { '720p': 450, '1080p': 300, '4k': 180 }
const ENCODE_HW: ReadonlyArray<readonly [string, HwPref]> = [
  ['hw', 'prefer-hardware'],
  ['nopref', 'no-preference'],
  ['sw', 'prefer-software'],
]

type PoolSource = 'canvas' | 'i420' | 'nv12'
type FramePool = Record<PoolSource, VideoFrame[]>

function closePool(pool: FramePool): void {
  for (const frames of Object.values(pool)) for (const f of frames) f.close()
}

// POOL_SIZE consecutive export frames from 25% into the piece (after a short
// run-in so particles are alive, like frame N of a real export). CPU copies
// (`cpu: true`) go through a 2D canvas → planar YUV.
async function buildFramePool(
  ctx: AppCtxValue,
  midi: MidiFile,
  fps: number,
  cpu: boolean,
): Promise<FramePool> {
  const { renderer, clock } = ctx.services
  const canvas = renderer.canvas
  const width = canvas.width & ~1
  const height = canvas.height & ~1
  const t0 = midi.duration * 0.25
  const pool: FramePool = { canvas: [], i420: [], nv12: [] }
  const scratch = cpu
    ? new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })
    : null
  for (let i = -10; i < POOL_SIZE; i++) {
    const t = t0 + i / fps
    clock.seek(t)
    renderer.renderManualFrame(t, 1 / fps)
    if (i < 0) continue
    const frame = exportFrame(canvas, 0, width, height)
    pool.canvas.push(frame)
    if (scratch) {
      scratch.drawImage(frame, 0, 0)
      const rgba = scratch.getImageData(0, 0, width, height).data
      const init = { codedWidth: width, codedHeight: height, timestamp: 0 }
      pool.i420.push(
        new VideoFrame(rgbaToYuv420(rgba, width, height, false), { ...init, format: 'I420' }),
      )
      pool.nv12.push(
        new VideoFrame(rgbaToYuv420(rgba, width, height, true), { ...init, format: 'NV12' }),
      )
    }
    await yieldNow()
  }
  return pool
}

// RGBA → 4:2:0 limited-range YUV, I420 (planar) or NV12 (interleaved UV).
// Chroma taken from each 2×2 block's top-left pixel: colour accuracy is
// irrelevant here, only that the encoder sees real picture content in its
// native layout. `w`/`h` must be even.
function rgbaToYuv420(rgba: Uint8ClampedArray, w: number, h: number, nv12: boolean): Uint8Array {
  const ySize = w * h
  const cw = w >> 1
  const ch = h >> 1
  const out = new Uint8Array(ySize + 2 * cw * ch)
  for (let i = 0, p = 0; i < ySize; i++, p += 4) {
    out[i] = ((66 * rgba[p]! + 129 * rgba[p + 1]! + 25 * rgba[p + 2]! + 128) >> 8) + 16
  }
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const p = (2 * y * w + 2 * x) * 4
      const r = rgba[p]!
      const g = rgba[p + 1]!
      const b = rgba[p + 2]!
      const u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128
      const v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128
      const c = y * cw + x
      if (nv12) {
        out[ySize + 2 * c] = u
        out[ySize + 2 * c + 1] = v
      } else {
        out[ySize + c] = u
        out[ySize + cw * ch + c] = v
      }
    }
  }
  return out
}

async function suiteEncodeMax(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('WebCodecs unavailable - encodemax cannot run in this browser')
  }
  const params = new URLSearchParams(window.location.search)
  const { res: resParam, fps } = exportParams()
  const res = resParam ?? '1080p'
  const midi = await loadFixture(ctx, fixtureId)
  const exportCanvas = enterExportCanvas(ctx, res)
  let pool: FramePool | null = null
  try {
    const width = exportCanvas.width & ~1
    const height = exportCanvas.height & ~1
    const bitrate = resolveExportBitrate(res)
    const frames = ENCODEMAX_FRAMES[res]
    const out: Record<string, number> = { width, height, fps, frames }
    progress('encodemax:pool')
    pool = await buildFramePool(ctx, midi, fps, true)
    // Cold start first, from a CPU source: the page's first encoder pays the
    // browser's encoder start-up (seconds for Chrome's first hardware encoder
    // of a session), which would otherwise land on whichever matrix cell runs
    // first. `cold-hw_lat` is that cost (`&cold=sw` probes a software encoder
    // first instead → `cold-sw_lat`); hw-canvas's own `lat` then isolates
    // canvas-path set-up.
    const coldName = params.get('cold') === 'sw' ? 'sw' : 'hw'
    progress(`encodemax:cold-${coldName}`)
    const coldConfig = await probeH264({
      width,
      height,
      fps,
      bitrate,
      hw: coldName === 'sw' ? 'prefer-software' : 'prefer-hardware',
    })
    if (coldConfig) {
      const r = await runEncodeLoop({ config: coldConfig, pool: pool.i420, frames: 30, fps })
      out[`cold-${coldName}_lat`] = round((r.outTimes[0] ?? r.endMs) - r.startMs)
      out[`cold-${coldName}_fps`] = round(overallFps([r]))
    }
    for (const [hwName, hw] of ENCODE_HW) {
      const config = await probeH264({ width, height, fps, bitrate, hw })
      for (const src of ['canvas', 'i420', 'nv12'] as const) {
        const cell = `${hwName}-${src}`
        progress(`encodemax:${cell}`)
        if (!config) {
          out[`${cell}_fps`] = -1
          continue
        }
        try {
          const r = await runEncodeLoop({ config, pool: pool[src], frames, fps })
          out[`${cell}_fps`] = round(overallFps([r]))
          out[`${cell}_steady`] = round(steadyFps([r.outTimes]))
          out[`${cell}_kbpf`] = round(r.bytes / 1024 / r.frames)
          out[`${cell}_dq`] = r.dequeues
          out[`${cell}_lat`] = round((r.outTimes[0] ?? r.endMs) - r.startMs)
        } catch (err) {
          console.warn(`[encodemax] ${cell} failed`, err)
          out[`${cell}_fps`] = -2
        }
      }
    }
    return out
  } finally {
    if (pool) closePool(pool)
    exportCanvas.restore()
  }
}

// ── encodepar: do parallel encoders add throughput? ───────────────────────
// K = 1..4 concurrent VideoEncoders fed encodemax's pre-rendered pool, each
// encoding ENCODEPAR_FRAMES[res] frames, driven either from the main thread
// (K interleaved async loops) or from one DedicatedWorker per encoder
// (encodeWorker.ts; pool clones transferred, all workers released together).
// Plans: hw-canvas, sw-canvas, sw-i420. Reports the aggregate steady-state
// rate over the window where all K run (`steady`), whole-run `fps`, and the
// scaling factor vs K=1 of the same plan and mode (`x`). This is the
// question behind segment-parallel export: can K encoders digest more
// frames per second than one?

const ENCODEPAR_FRAMES: Record<ExportPresetRes, number> = { '720p': 240, '1080p': 160, '4k': 80 }
const ENCODEPAR_MAX_K = 4
const ENCODEPAR_CELL_TIMEOUT_MS = 180_000
const ENCODEPAR_PLANS: ReadonlyArray<{ name: string; hw: HwPref; src: PoolSource }> = [
  { name: 'hw-canvas', hw: 'prefer-hardware', src: 'canvas' },
  { name: 'sw-canvas', hw: 'prefer-software', src: 'canvas' },
  { name: 'sw-i420', hw: 'prefer-software', src: 'i420' },
]

function nextWorkerReply(w: Worker): Promise<EncodeWorkerReply> {
  return new Promise((resolve, reject) => {
    w.onmessage = (e: MessageEvent) => resolve(e.data as EncodeWorkerReply)
    w.onerror = (e) => reject(new Error(`encode worker: ${e.message}`))
  })
}

async function encodeInWorkers(
  config: VideoEncoderConfig,
  pool: readonly VideoFrame[],
  k: number,
  frames: number,
  fps: number,
): Promise<EncodeRunResult[]> {
  const workers: Worker[] = []
  try {
    for (let i = 0; i < k; i++) {
      workers.push(new Worker(new URL('./encodeWorker.ts', import.meta.url), { type: 'module' }))
    }
    await Promise.all(
      workers.map(async (w) => {
        const reply = nextWorkerReply(w)
        const clones = pool.map((f) => f.clone())
        try {
          w.postMessage({ kind: 'setup', config, pool: clones, frames, fps }, clones)
        } catch (err) {
          for (const c of clones) c.close()
          throw err
        }
        const r = await reply
        if (r.kind !== 'ready') throw new Error(`encode worker setup: ${JSON.stringify(r)}`)
      }),
    )
    const done = workers.map((w) => nextWorkerReply(w))
    for (const w of workers) w.postMessage({ kind: 'go' })
    return (await Promise.all(done)).map((r) => {
      if (r.kind !== 'done') throw new Error(r.kind === 'error' ? r.error : 'unexpected reply')
      return r.result
    })
  } finally {
    for (const w of workers) w.terminate()
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([p, expiry]).finally(() => clearTimeout(timer))
}

async function suiteEncodePar(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('WebCodecs unavailable - encodepar cannot run in this browser')
  }
  const { res: resParam, fps } = exportParams()
  const res = resParam ?? '1080p'
  const midi = await loadFixture(ctx, fixtureId)
  const exportCanvas = enterExportCanvas(ctx, res)
  let pool: FramePool | null = null
  try {
    const width = exportCanvas.width & ~1
    const height = exportCanvas.height & ~1
    const bitrate = resolveExportBitrate(res)
    const frames = ENCODEPAR_FRAMES[res]
    const out: Record<string, number> = { width, height, fps, frames }
    progress('encodepar:pool')
    pool = await buildFramePool(ctx, midi, fps, true)
    for (const plan of ENCODEPAR_PLANS) {
      const config = await probeH264({ width, height, fps, bitrate, hw: plan.hw })
      for (const mode of ['main', 'worker'] as const) {
        let single = 0
        for (let k = 1; k <= ENCODEPAR_MAX_K; k++) {
          const cell = `${plan.name}-${mode}-k${k}`
          progress(`encodepar:${cell}`)
          if (!config) {
            out[`${cell}_steady`] = -1
            continue
          }
          const src = pool[plan.src]
          try {
            const runs = await withTimeout(
              mode === 'main'
                ? Promise.all(
                    Array.from({ length: k }, () =>
                      runEncodeLoop({ config, pool: src, frames, fps }),
                    ),
                  )
                : encodeInWorkers(config, src, k, frames, fps),
              ENCODEPAR_CELL_TIMEOUT_MS,
              cell,
            )
            const steady = steadyFps(runs.map((r) => r.outTimes))
            if (k === 1) single = steady
            out[`${cell}_steady`] = round(steady)
            out[`${cell}_fps`] = round(overallFps(runs))
            out[`${cell}_x`] = single > 0 && steady > 0 ? round(steady / single) : -1
          } catch (err) {
            console.warn(`[encodepar] ${cell} failed`, err)
            out[`${cell}_steady`] = -2
          }
        }
      }
    }
    return out
  } finally {
    if (pool) closePool(pool)
    exportCanvas.restore()
  }
}

// ── audiorender: offline audio render cost per instrument ─────────────────
// How long the "Rendering audio" export stage takes relative to the piece
// (realtime factor), for a sampled instrument and a convolution-reverb synth.
async function suiteAudioRender(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  const midi = await loadFixture(ctx, fixtureId)
  const { renderAudioOffline } = await import('../audio/OfflineAudioRenderer')
  const out: Record<string, number> = { durationS: round(midi.duration) }
  for (const id of ['piano', 'upright', 'bells', 'digital'] as const) {
    progress(`audiorender:${id}`)
    // Warm the sample cache so the number is the render, not the download.
    await renderAudioOffline({ midi: { ...midi, duration: 2 }, instrumentId: id, volume: 0.8 })
    const t0 = performance.now()
    await renderAudioOffline({ midi, instrumentId: id, volume: 0.8 })
    const ms = performance.now() - t0
    out[`${id}_ms`] = round(ms)
    out[`${id}_xRealtime`] = round(midi.duration / (ms / 1000))
  }
  return out
}

function heapMB(): number {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  return mem ? mem.usedJSHeapSize / (1024 * 1024) : 0
}

// ── headroom: pre-clip peak per instrument on held clusters ───────────────
// Renders synthetic held-note fixtures (src/bench/audioFixtures.ts) offline
// through the real instrument chain and measures how far the summed signal
// exceeds full scale. Offline buffers are unclamped, so `peakDb > 0` is
// exactly the overshoot the online path hard-clips into crunch. Deterministic
// — no timing, no frame pacing — so the driver runs it once.
// See docs/AUDIO_GLITCH_HARNESS_2026-09-05.md.

// Store default (src/store/state.ts) — the level a fresh install plays at.
const HEADROOM_VOLUME = 0.8

async function loadAudioFixture(id: string): Promise<MidiFile> {
  const { applyBarSustain, buildSyntheticFixture, isAudioFixtureId, truncateMidi } = await import(
    './audioFixtures'
  )
  if (!isAudioFixtureId(id)) throw new Error(`unknown audio fixture: ${id}`)
  if (id !== 'pedal-piece' && id !== 'piece-20') return buildSyntheticFixture(id)
  // Real piece + bar-length sustain: the playback-with-pedal case. Fetched
  // directly rather than via loadFixture — no play-mode side effects needed.
  const base = BENCH_FIXTURES[0]!
  const res = await fetch(base.url)
  if (!res.ok) throw new Error(`fixture fetch failed: ${base.url} → ${res.status}`)
  const piece = applyBarSustain(await parseMidiFile(await res.arrayBuffer(), base.id))
  return id === 'piece-20' ? truncateMidi(piece, 20) : piece
}

function requestedInstruments(): InstrumentId[] {
  const all = INSTRUMENTS.map((i) => i.id)
  const param = new URLSearchParams(window.location.search).get('instruments')
  if (!param) return all
  const ids = param.split(',').filter(Boolean)
  for (const id of ids) {
    if (!all.includes(id as InstrumentId)) throw new Error(`unknown instrument: ${id}`)
  }
  return ids as InstrumentId[]
}

async function suiteHeadroom(ctx: AppCtxValue, fixtureId: string): Promise<Record<string, number>> {
  const midi = await loadAudioFixture(fixtureId)
  // Sample decode happens on the online context; make sure it's running.
  ctx.primeInteractiveAudio()
  const { renderAudioOffline } = await import('../audio/OfflineAudioRenderer')
  const { analyseBuffer, measureLoudness } = await import('./audioAnalysis')
  const { notesSoundingAt } = await import('./audioFixtures')

  // `&protection=off` measures raw instrument levels (for setting trims);
  // default is the shipped path, soft-clip ceiling included.
  const raw = new URLSearchParams(window.location.search).get('protection') === 'off'
  const out: Record<string, number> = {
    durationS: round(midi.duration),
    protectionOn: raw ? 0 : 1,
  }
  for (const id of requestedInstruments()) {
    progress(`headroom:${id}`)
    const buffer = await renderAudioOffline({
      midi,
      instrumentId: id,
      volume: HEADROOM_VOLUME,
      busRouting: raw ? 'raw' : 'protected',
    })
    // RMS over the held region only; the 1.5 s render tail would dilute it.
    const m = analyseBuffer(buffer, { from: 0, to: midi.duration })
    out[`${id}_peakDb`] = m.peakDb
    out[`${id}_clipPct`] = m.clipPct
    out[`${id}_clipRunMaxMs`] = m.clipRunMaxMs
    out[`${id}_rmsDb`] = m.rmsDb
    out[`${id}_crestDb`] = m.crestDb
    out[`${id}_aboveKneePct`] = m.aboveKneePct
    // Notes sounding at the first clipped sample; 0 = never clipped.
    out[`${id}_firstClipNotes`] = m.firstClipS < 0 ? 0 : notesSoundingAt(midi, m.firstClipS)
    // Perceived loudness (K-weighted). `lufsM` is what to balance on.
    const channels: Float32Array[] = []
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
    const l = measureLoudness(channels, buffer.sampleRate)
    out[`${id}_lufsI`] = l.integratedLufs
    out[`${id}_lufsM`] = l.maxMomentaryLufs
  }
  return out
}

// ── voiceload: live voice pile-up on the online context ───────────────────
// Reproduces Wyatt's method on the REAL live path (`SynthEngine.liveNoteOn`,
// online AudioContext): one full-velocity note per beat at 185 BPM, all held,
// then a 3 s steady state. Underrun proxy: Chrome advances
// `AudioContext.currentTime` only as quanta are rendered, so when the audio
// thread falls behind, context time lags wall time. `driftMs` is that lag;
// `firstDriftNote` is the note count at which it first exceeds
// DRIFT_THRESHOLD_MS — directly comparable to Wyatt's per-instrument table.
// (`AudioContext.renderCapacity` is not exposed by the bundled Chromium,
// even behind Blink flags — checked 2026-09-05.)
//
// Caveats, both stated in docs/AUDIO_GLITCH_HARNESS_2026-09-05.md: headless
// output goes to a fake sink (still realtime-paced), and CDP CPU throttling
// slows the main thread more reliably than the audio render thread. Numbers
// are indicative and relative, not a CI gate.

const VOICELOAD_PITCHES = [48, 52, 55, 59, 62, 64, 67, 71, 72, 76, 79, 83, 84, 88, 91, 95]
// One render quantum at 44.1 kHz is ~2.9 ms; ordinary jitter stays well
// under 10 ms. Anything past this is the audio thread genuinely behind.
const DRIFT_THRESHOLD_MS = 10
const VOICELOAD_HOLD_MS = 3000
const VOICELOAD_TAIL_MS = 2500

async function suiteVoiceload(
  ctx: AppCtxValue,
  _fixtureId: string,
): Promise<Record<string, number>> {
  const { getContext } = await import('tone')
  const { STACK_BPM } = await import('./audioFixtures')
  const stepMs = (60 / STACK_BPM) * 1000
  const synth = ctx.services.synth
  ctx.primeInteractiveAudio()
  const native = getContext().rawContext as AudioContext

  const out: Record<string, number> = { notes: VOICELOAD_PITCHES.length, stepMs: round(stepMs) }
  for (const id of requestedInstruments()) {
    progress(`voiceload:${id}:load`)
    await synth.setInstrument(id)
    synth.primeLiveInput()
    await sleep(500)

    const wall0 = performance.now()
    const ctx0 = native.currentTime
    const drift = (): number => performance.now() - wall0 - (native.currentTime - ctx0) * 1000
    let driftMax = 0
    let firstDriftNote = 0
    const sample = (noteCount: number): void => {
      const d = drift()
      if (d > driftMax) driftMax = d
      if (!firstDriftNote && d > DRIFT_THRESHOLD_MS) firstDriftNote = noteCount
    }

    for (let i = 0; i < VOICELOAD_PITCHES.length; i++) {
      progress(`voiceload:${id}:note${i + 1}`)
      synth.liveNoteOn(VOICELOAD_PITCHES[i]!, 1)
      await sleep(stepMs)
      sample(i + 1)
    }
    // Steady state with the full stack held — sample a few times so a late
    // drift still registers against the full count.
    for (let t = 0; t < VOICELOAD_HOLD_MS; t += 250) {
      await sleep(250)
      sample(VOICELOAD_PITCHES.length)
    }
    synth.liveReleaseAll()
    await sleep(VOICELOAD_TAIL_MS)

    out[`${id}_driftMs`] = round(driftMax)
    out[`${id}_firstDriftNote`] = firstDriftNote
  }
  return out
}

// ── entry point (called from main.tsx behind VITE_ENABLE_BENCH) ───────────

// ── glowshots: the note glow, filter vs baked, on identical frames ─────────
// Visual A/B for renderer/bakedGlow.ts. Renders a few chosen moments of the
// fixture on the export canvas (`&res=`, default 1080p) once per glow path and
// publishes the frames on `window.__GLOW_SHOTS` (PNG data URLs, keyed
// `<theme>-<moment>-<mode>`) for a script to save, plus RGB PSNR between the
// two paths per moment. Particles and labels off, so the glow is the only
// difference. Moments: `dense` (most notes sounding), `lone` (exactly one),
// `ending` (the dense chord's first note 40 ms before it ends — slivers at the
// strike line). `&themes=a,b` (default sunset, the new-visitor theme).
async function suiteGlowShots(
  ctx: AppCtxValue,
  fixtureId: string,
): Promise<Record<string, number>> {
  const params = new URLSearchParams(window.location.search)
  const res = exportParams().res ?? '1080p'
  const themes = (params.get('themes') ?? 'sunset').split(',') as ThemeId[]
  const midi = await loadFixture(ctx, fixtureId)
  const notes = midi.tracks.flatMap((t) => t.notes)
  const sounding = (t: number) => notes.filter((n) => n.time <= t && n.time + n.duration >= t)
  let dense = 0
  let lone = -1
  for (let t = 0.5; t < Math.min(midi.duration, 60); t += 0.05) {
    const n = sounding(t).length
    if (n > sounding(dense).length) dense = t
    if (n === 1 && lone < 0) lone = t
  }
  const firstEnd = Math.min(...sounding(dense).map((n) => n.time + n.duration))
  const moments: Record<string, number> = { dense, ending: firstEnd - 0.04 }
  if (lone >= 0) moments.lone = lone

  const { renderer } = ctx.services
  const pageGlow = glowSettings()
  const restoreTheme = renderer.currentTheme
  const exportCanvas = enterExportCanvas(ctx, res)
  const { width, height } = exportCanvas
  const grab = document.createElement('canvas')
  grab.width = width
  grab.height = height
  const g = grab.getContext('2d', { willReadFrequently: true })!
  const shots: Record<string, string> = {}
  const out: Record<string, number> = { width, height }
  try {
    for (const theme of themes) {
      for (const [moment, t] of Object.entries(moments)) {
        const px: Partial<Record<GlowMode, Uint8ClampedArray>> = {}
        for (const mode of ['filter', 'baked'] as const) {
          applyStageConfig(
            ctx,
            {
              name: 'glowshots',
              theme,
              particles: 'none',
              glow: true,
              glowMode: mode,
              labels: false,
            },
            pageGlow.mode,
          )
          // A few frames up to t so per-frame state (active-note sets) settles.
          for (let k = 3; k >= 0; k--) renderer.renderManualFrame(t - k / 30, 1 / 30)
          g.clearRect(0, 0, width, height)
          g.drawImage(renderer.canvas, 0, 0) // same task as the render
          px[mode] = g.getImageData(0, 0, width, height).data
          shots[`${theme}-${moment}-${mode}`] = grab.toDataURL('image/png')
        }
        let se = 0
        const a = px.filter!
        const b = px.baked!
        for (let i = 0; i < a.length; i += 4) {
          for (let c = 0; c < 3; c++) se += (a[i + c]! - b[i + c]!) ** 2
        }
        out[`${theme}_${moment}_psnr`] =
          se === 0 ? 99 : round(10 * Math.log10((255 * 255) / (se / ((a.length / 4) * 3))))
        out[`${theme}_${moment}_notes`] = sounding(t).length
      }
    }
    window.__GLOW_SHOTS = shots
    window.__GLOW_SHOT_TIMES = moments
    return out
  } finally {
    setGlowMode(pageGlow.mode, pageGlow.tint)
    renderer.setTheme(restoreTheme)
    exportCanvas.restore()
  }
}

const SUITES: Record<
  BenchSuite,
  (ctx: AppCtxValue, fixture: string) => Promise<Record<string, number>>
> = {
  frame: suiteFrame,
  attribution: suiteAttribution,
  live: suiteLive,
  idle: suiteIdle,
  pacing: suitePacing,
  export: suiteExport,
  exportlab: suiteExportLab,
  exportreal: suiteExportReal,
  exportstages: suiteExportStages,
  encodemax: suiteEncodeMax,
  encodepar: suiteEncodePar,
  exportquality: suiteExportQuality,
  glowshots: suiteGlowShots,
  audiorender: suiteAudioRender,
  headroom: suiteHeadroom,
  voiceload: suiteVoiceload,
}

// Time the page spent hidden during the run, reported as `hiddenMs` on every
// result. A hidden tab (user switched tabs, window occluded) gets throttled
// timers and paused rAF, which silently turns a timing run into garbage — the
// driver flags any run with hiddenMs > 0 so it can't pass for a slow one.
function trackHiddenTime(): () => number {
  let total = 0
  let since = document.visibilityState === 'hidden' ? performance.now() : -1
  const onChange = (): void => {
    if (document.visibilityState === 'hidden') {
      if (since < 0) since = performance.now()
    } else if (since >= 0) {
      total += performance.now() - since
      since = -1
    }
  }
  document.addEventListener('visibilitychange', onChange)
  return () => {
    document.removeEventListener('visibilitychange', onChange)
    return Math.round(total + (since >= 0 ? performance.now() - since : 0))
  }
}

// `&glow=` / `&glowTint=` (see header). Also applied when there is no suite:
// a bench build opened as `/?glow=filter` is the manual glow A/B.
function applyGlowParams(params: URLSearchParams): void {
  const mode = params.get('glow') ?? glowSettings().mode
  const tint = params.get('glowTint') ?? glowSettings().tint
  if (mode !== 'filter' && mode !== 'baked') {
    throw new Error(`bench: glow must be filter|baked, got ${mode}`)
  }
  if (tint !== 'average' && tint !== 'note') {
    throw new Error(`bench: glowTint must be average|note, got ${tint}`)
  }
  setGlowMode(mode, tint)
}

export async function maybeRunBench(ctx: AppCtxValue): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const suiteParam = params.get('bench')
  if (!suiteParam) {
    applyGlowParams(params)
    return
  }
  initReport(params)

  if (suiteParam === 'list') {
    const { AUDIO_FIXTURE_IDS } = await import('./audioFixtures')
    // Audio ids first: the driver waits on __BENCH_FIXTURES, so both must be
    // in place by the time it appears.
    window.__BENCH_AUDIO_FIXTURES = [...AUDIO_FIXTURE_IDS]
    window.__BENCH_FIXTURES = BENCH_FIXTURES.map((f) => f.id)
    await postReport({
      kind: 'list',
      midi: window.__BENCH_FIXTURES,
      audio: window.__BENCH_AUDIO_FIXTURES,
    })
    return
  }

  const hiddenMs = trackHiddenTime()
  try {
    const suite = suiteParam as BenchSuite
    const run = SUITES[suite]
    if (!run) throw new Error(`unknown bench suite: ${suiteParam}`)
    applyGlowParams(params)
    const fixture = params.get('fixture') ?? BENCH_FIXTURES[0]!.id
    const metrics = await run(ctx, fixture)
    metrics.hiddenMs = hiddenMs()
    const result: BenchResult = {
      schema: 2,
      suite,
      fixture,
      env: captureEnv(ctx),
      metrics,
    }
    window.__BENCH_RESULT = result
    await postReport({ kind: 'result', result })
  } catch (err) {
    window.__BENCH_ERROR = err instanceof Error ? err.message : String(err)
    console.error('[bench]', err)
    await postReport({
      kind: 'error',
      error: window.__BENCH_ERROR,
      progress: window.__BENCH_PROGRESS ?? null,
    })
  }
}
