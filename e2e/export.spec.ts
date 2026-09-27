import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, type Page, test } from '@playwright/test'
import { decodeExport, type FrameScore, installFrameSnapshots } from './helpers/decode'
import {
  parseEsds,
  parseTopLevelBoxes,
  readAudioSpecificConfig,
  readMovieDurationSeconds,
  readTrackHandlers,
} from './helpers/mp4'

// Task I (FULL export e2e — Step 3a of docs/TESTING_STRATEGY_2026-06-21.md).
//
// The spike (e2e/spike.codec.spec.ts) confirmed WebCodecs H.264 + AAC encode works in
// headless Chromium with NO special flags (secure context only). So we drive the REAL
// flagship export end-to-end and assert the produced file is a valid MP4.
//
// Flow (mapped from src/app.ts + src/ui/*):
//   1. Load a short MIDI via the hidden file input (#midi-input) — we use
//      fixtures/multi-track.mid (1.95s, 2 tracks) so the export is fast.
//   2. The app enters PLAY mode and the export button (#ts-record) un-hides.
//   3. Click #ts-record -> the export modal (#export-modal) opens.
//   4. Pick output, click the Export action -> encoder runs.
//   5. The app finishes by triggering an <a download> click; Playwright's download
//      API captures the bytes. We then validate the MP4 container in-process.
//
// Determinism: we never assert wall-clock timing. Duration is checked against the
// known fixture length with tolerance.
//
// The AV tests then DECODE the file in the page (helpers/decode.ts): container
// checks alone passed while Safari shipped an undecodable audio track.

const FIXTURE_MID = fileURLToPath(new URL('../fixtures/multi-track.mid', import.meta.url))
const FIXTURE_DURATION_S = 1.95 // from `@tonejs/midi` parse of fixtures/multi-track.mid
const SYNC_MID = fileURLToPath(new URL('../fixtures/sync-note.mid', import.meta.url))
const SYNC_NOTE_S = 1 // the fixture's only note starts here
// ~4.5 min: its offline audio render is still running when the test cancels.
const LONG_MID = fileURLToPath(
  new URL('../public/samples/chopin-nocturne-op9-2.mid', import.meta.url),
)
// Decoded frame vs the renderer's own canvas, both box-filtered to 128×72.
// Measured 46 dB (720p30, 2026-09-27); adjacent frames differ at 32–39 dB, so a
// wrong, black, shifted or colour-cast frame lands far below. Headroom left for
// encoder tuning (bitrate, latency mode) during perf work.
const MIN_FRAME_PSNR_DB = 38
const MAX_AV_OFFSET_S = 0.1

async function loadFixtureAndOpenExport(page: Page, midi = FIXTURE_MID): Promise<void> {
  await loadFixture(page, midi)
  await openExport(page)
}

async function loadFixture(page: Page, midi: string): Promise<void> {
  await page.goto('/')

  // Secure-context guard — WebCodecs encoders require it (spike finding).
  expect(await page.evaluate(() => window.isSecureContext)).toBe(true)

  // The file input is hidden (display:none) but present; setInputFiles works on it.
  const input = page.locator('#midi-input')
  await input.waitFor({ state: 'attached' })
  await input.setInputFiles(midi)

  // Loading a file transitions to play mode; the export button un-hides once a file
  // is loaded and not still loading. Wait for it to be visible (not just attached).
  await expect(page.locator('#ts-record')).toBeVisible({ timeout: 30_000 })
}

async function openExport(page: Page): Promise<void> {
  await page.locator('#ts-record').click()
  // Modal opens by gaining the `open` class.
  await expect(page.locator('#export-modal')).toHaveClass(/open/, { timeout: 15_000 })
}

// The redesigned dialog's Quality / Motion segmented controls.
async function chooseVideoPreset(
  page: Page,
  quality: '720p' | '1080p',
  fps: 30 | 60,
): Promise<void> {
  await page.locator('#export-modal .fps-btn', { hasText: quality }).click()
  await page.locator('#export-modal .fps-btn', { hasText: `${fps} fps` }).click()
}

async function exportWav(page: Page): Promise<Uint8Array> {
  await page.locator('#export-modal .export-tab', { hasText: 'Audio' }).click()
  await page.locator('#export-modal .export-choice', { hasText: 'WAV' }).click()
  return (await runExportAndCapture(page)).bytes
}

// RMS in dBFS of a 16-bit PCM WAV (the shape src/export/wav.ts writes).
function wavRmsDb(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dataSize = dv.getUint32(40, true)
  let sumSq = 0
  for (let o = 44; o < 44 + dataSize; o += 2) sumSq += (dv.getInt16(o, true) / 32768) ** 2
  return 10 * Math.log10(sumSq / (dataSize / 2))
}

// Frames that match a neighbour's snapshot at least as well as their own —
// the signature of an off-by-one capture. Only judged where the scene moved
// (neighbouring snapshots differ by more than codec noise), since identical
// neighbours are indistinguishable by definition.
function staleFrames(scores: FrameScore[]): number[] {
  const moved = (motion: number | null | undefined, own: number) =>
    motion !== null && motion !== undefined && motion < own - 3
  return scores.flatMap((s, i) =>
    (moved(s.motion, s.own) && s.prev! >= s.own) ||
    (moved(scores[i + 1]?.motion, s.own) && s.next! >= s.own)
      ? [i]
      : [],
  )
}

// Playhead seconds per wall second over `windows` one-second windows, plus the
// HUD time at each sample. Timed in-page so round trips don't count.
function sampleClock(page: Page, windows: number): Promise<{ rates: number[]; times: string[] }> {
  return page.evaluate(async (n) => {
    const scrubber = document.querySelector<HTMLInputElement>('#hud-scrubber')!
    const time = document.querySelector('#hud-time')!
    const sample = () => ({ at: performance.now() / 1000, t: Number.parseFloat(scrubber.value) })
    const rates: number[] = []
    const times = [time.textContent?.trim() ?? '']
    let prev = sample()
    for (let i = 0; i < n; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const next = sample()
      rates.push(Math.round(((next.t - prev.t) / (next.at - prev.at)) * 100) / 100)
      times.push(time.textContent?.trim() ?? '')
      prev = next
    }
    return { rates, times }
  }, windows)
}

const hex = (s: string) => Uint8Array.from(s.match(/[0-9a-f]{2}/gi)!, (b) => Number.parseInt(b, 16))

async function runExportAndCapture(
  page: Page,
): Promise<{ bytes: Uint8Array; suggestedFilename: string }> {
  // The export completes by triggering an anchor download; capture it.
  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 })

  // The Export action button is the accent button in the modal.
  await page.locator('#export-modal .modal-btn--accent').click()

  const download = await downloadPromise
  const path = await download.path()
  const bytes = new Uint8Array(await readFile(path))
  return { bytes, suggestedFilename: download.suggestedFilename() }
}

// Trace screenshots capture every repaint of a canvas redrawing at encode speed;
// on SwiftShader that stalls an export for minutes (720p60 1.5 s clip: 14 s
// without, >90 s with). DOM snapshots + network stay in the trace. File-level:
// trace is a worker option.
test.use({ trace: { mode: 'retain-on-failure', screenshots: false } })

test.describe('MP4 export (flagship, full WebCodecs path)', () => {
  // Runs in the default suite (no browser): pins the parser on the exact bytes a
  // Safari 26.1 export carried, so the AV test's config check can't go blind.
  test('AAC config parser flags the descriptor Safari 26 emits (WebKit 302253)', () => {
    const safari = hex(
      '00000000 033e0001 00043640 15000000 00000000 00000000 05270380 80802200 00000480 80801440' +
        '14001800 00000000 00000000 00058080 80021210 06808080 0102 060102',
    )
    expect(parseEsds(safari)?.objectType).toBe(0)
    const valid = hex('00000000 03190001 00041140 15000000 00000000 00000000 05021210 060102')
    expect(parseEsds(valid)).toEqual({ objectType: 2, sampleRate: 44_100, channels: 2 })
  })

  test('AV export plays: decodable audio at the rendered level, exact frames, no stale frames', async ({
    page,
  }) => {
    // The AV path runs a real software H.264 encode (slow + timing-flaky, and may
    // lack a usable encoder on some CI hosts — see BUG-1). It's quarantined from the
    // default run so local/CI stay fast & deterministic. Run with E2E_HEAVY=1
    // (`npm run test:e2e:heavy`). The codec spike + audio-only export already cover
    // the WebCodecs/mux path in the default suite.
    test.skip(!process.env.E2E_HEAVY, 'heavy AV encode — run with E2E_HEAVY=1')
    await installFrameSnapshots(page)
    await loadFixtureAndOpenExport(page)

    // Default output is 'av' (video+audio). Use the smallest preset for speed.
    await chooseVideoPreset(page, '720p', 30)

    const { bytes, suggestedFilename } = await runExportAndCapture(page)

    expect(suggestedFilename).toMatch(/\.mp4$/)
    expect(bytes.byteLength).toBeGreaterThan(1000)

    // Structural smoke test (NOT a full decode): the file must have ftyp + moov +
    // mdat at top level. This proves a well-formed container with declared tracks,
    // not that every sample decodes — a real player would be needed for that.
    const boxes = parseTopLevelBoxes(bytes)
    const types = boxes.map((b) => b.type)
    expect(types, `top-level boxes: ${types.join(',')}`).toContain('ftyp')
    expect(types).toContain('moov')
    expect(types).toContain('mdat')

    // The mdat must carry real sample payload — an empty/garbage mdat would still
    // pass the box-presence checks above, so guard against a header-only file.
    const mdat = boxes.find((b) => b.type === 'mdat')
    expect(mdat!.payloadSize, 'mdat payload must hold encoded samples').toBeGreaterThan(2_000)

    // Track presence: one video ('vide') and one audio ('soun') handler.
    const handlers = readTrackHandlers(bytes)
    expect(handlers, `handlers: ${handlers.join(',')}`).toContain('vide')
    expect(handlers).toContain('soun')

    // Duration ≈ clip length (1.95s). AV trims audio to midi.duration; video frames
    // cover ceil(duration*fps) ≈ 1.96s. Band is tight enough to catch a real trim
    // regression: a half-length export (~0.98s) fails the lower bound, and an
    // untrimmed-tail leak (~3.45s, the audio-only bug reaching AV) fails the upper.
    const dur = readMovieDurationSeconds(bytes)
    expect(dur, 'mvhd duration present').not.toBeNull()
    expect(dur!, `mvhd duration ${dur}s should be ≈${FIXTURE_DURATION_S}s`).toBeGreaterThan(1.6)
    expect(dur!, `mvhd duration ${dur}s should be ≈${FIXTURE_DURATION_S}s`).toBeLessThan(2.5)

    // The AAC config every player parses first (a bad one = no sound anywhere).
    expect(readAudioSpecificConfig(bytes)).toEqual({
      objectType: 2,
      sampleRate: 44_100,
      channels: 2,
    })

    const { video, audio } = await decodeExport(page, bytes)

    // Video: preset dimensions, one frame per 1/fps tick from 0, none missing.
    expect([video.width, video.height]).toEqual([1280, 720])
    expect(video.timestamps).toHaveLength(Math.ceil(FIXTURE_DURATION_S * 30))
    video.timestamps.forEach((t, i) => {
      expect(t, `frame ${i} timestamp`).toBeCloseTo(i / 30, 3)
    })

    // Every decoded frame is the frame the renderer drew for that tick.
    expect(video.snapshots, 'one canvas snapshot per encoded frame').toBe(video.timestamps.length)
    expect(video.scores).toHaveLength(video.timestamps.length)
    const worst = Math.min(...video.scores.map((s) => s.own))
    test.info().annotations.push({ type: 'worst-frame-psnr-db', description: worst.toFixed(1) })
    await test.info().attach('frame-scores.json', {
      body: JSON.stringify(video.scores),
      contentType: 'application/json',
    })
    expect(worst, 'worst decoded-vs-rendered PSNR (dB)').toBeGreaterThan(MIN_FRAME_PSNR_DB)
    expect(staleFrames(video.scores), 'frames matching a neighbour better than themselves').toEqual(
      [],
    )

    // Audio: decodes, and carries the same signal as the lossless render.
    expect(audio, 'decodable audio track').not.toBeNull()
    expect(audio!.sampleRate).toBe(44_100)
    expect(audio!.channels).toBe(2)
    expect(audio!.duration).toBeGreaterThan(FIXTURE_DURATION_S - 0.05)
    await page.locator('#ts-record').click()
    await expect(page.locator('#export-modal')).toHaveClass(/open/)
    const renderedDb = wavRmsDb(await exportWav(page))
    expect(renderedDb, 'the render itself is not silent').toBeGreaterThan(-50)
    expect(
      Math.abs(audio!.rmsDb - renderedDb),
      `AAC ${audio!.rmsDb} dB vs WAV ${renderedDb} dB`,
    ).toBeLessThan(1)
  })

  test('AV export keeps audio and picture in sync', async ({ page }) => {
    test.skip(!process.env.E2E_HEAVY, 'heavy AV encode — run with E2E_HEAVY=1')
    await loadFixtureAndOpenExport(page, SYNC_MID)
    await chooseVideoPreset(page, '720p', 60) // 16.7 ms frames: finer visual onset

    const { video, audio } = await decodeExport(page, (await runExportAndCapture(page)).bytes)

    // Picture: the first frame where the keyboard strip changes = the key lights.
    // The threshold sits well above whatever the keyboard does on its own.
    const idle = video.keyboardActivity.filter((_, i) => video.timestamps[i]! < SYNC_NOTE_S - 0.1)
    const threshold = Math.max(2, 3 * Math.max(...idle))
    const hit = video.keyboardActivity.findIndex((a) => a > threshold)
    expect(hit, 'the key lights up').toBeGreaterThan(0)
    const videoOnset = video.timestamps[hit]!
    const audioOnset = audio?.onset ?? Number.NaN

    // Each lands where the fixture puts the note...
    expect(videoOnset).toBeGreaterThanOrEqual(SYNC_NOTE_S - 0.001)
    expect(videoOnset).toBeLessThan(SYNC_NOTE_S + 2 / 60)
    expect(audioOnset).toBeGreaterThanOrEqual(SYNC_NOTE_S - 0.01)
    expect(audioOnset).toBeLessThan(SYNC_NOTE_S + MAX_AV_OFFSET_S)
    // ...and together. Today's offset is AAC encoder priming written at t=0
    // (~48 ms on Chrome/macOS); tighten MAX_AV_OFFSET_S once priming is trimmed.
    const offsetMs = Math.round((audioOnset - videoOnset) * 1000)
    test.info().annotations.push({ type: 'av-offset-ms', description: String(offsetMs) })
    expect(Math.abs(offsetMs), 'audio − video onset (ms)').toBeLessThan(MAX_AV_OFFSET_S * 1000)
  })

  // The reported flow: play a piece, export, cancel part-way, press play. The
  // offline render swaps Tone's global context — the one the clock and synth
  // read — and playback started on top of it stuck at a negative time. Quick
  // (cancelled as frames start) but still needs an H.264 encoder to get there.
  test('playback runs normally after cancelling an AV export mid-render', async ({ page }) => {
    test.skip(!process.env.E2E_HEAVY, 'needs an H.264 encoder — run with E2E_HEAVY=1')
    await loadFixture(page, LONG_MID)
    const play = page.locator('#hud-play')
    // Loading autoplays after 250 ms; wait for it, or it can start behind the
    // dialog and the export would resume it on cancel. Opening pauses.
    await expect(play).toHaveAttribute('data-playing', 'true')
    await openExport(page)
    await expect(play).toHaveAttribute('data-playing', 'false')
    await chooseVideoPreset(page, '720p', 30)
    await page.locator('#export-modal .modal-btn--accent').click()

    const progress = page.locator('#export-modal .export-progress:not(.hidden)')
    await expect(progress.locator('.export-stage-label')).toHaveText(/Exporting/, {
      timeout: 30_000,
    })
    await progress.locator('.modal-btn').click()
    await expect(page.locator('#export-modal')).not.toHaveClass(/open/, { timeout: 15_000 })

    const scrubber = page.locator('#hud-scrubber')
    const from = Number.parseFloat(await scrubber.inputValue())
    await play.hover()
    await play.click()
    await expect(play).toHaveAttribute('data-playing', 'true')
    await expect
      .poll(async () => Number.parseFloat(await scrubber.inputValue()), { timeout: 8_000 })
      .toBeGreaterThan(from + 0.2)

    // On the offline clock the playhead raced at render speed, froze, then
    // snapped negative on hand-back — so check the rate over several seconds.
    const { rates, times } = await sampleClock(page, 4)
    test.info().annotations.push({ type: 'playhead-rates', description: rates.join(' ') })
    for (const time of times) expect(time).toMatch(/^\d+:\d{2}$/)
    for (const rate of rates) {
      expect(rate).toBeGreaterThan(0.6)
      expect(rate).toBeLessThan(1.4)
    }
  })

  // NOT gated behind E2E_HEAVY: audio-only ships WAV/MP3 (both pure-JS, no codec),
  // so they run on GitHub's Linux Chromium too — unlike the AAC/.m4a path replaced.
  // Both are macOS-Gatekeeper-safe (see src/export/wav.ts, src/export/mp3.ts).
  test('audio-only WAV export is a valid RIFF file trimmed to the clip length', async ({
    page,
  }) => {
    await loadFixtureAndOpenExport(page)

    // "Audio" destination tab, then the WAV format choice (default is MP3).
    // Selectors verified against src/ui/ExportModal.tsx: tabs are
    // `.export-tab` (role=tab, label from i18n `export.tab.audio` = "Audio"),
    // formats are `.export-choice` with an upper-cased title span.
    await page.locator('#export-modal .export-tab', { hasText: 'Audio' }).click()
    await page.locator('#export-modal .export-choice', { hasText: 'WAV' }).click()

    const { bytes, suggestedFilename } = await runExportAndCapture(page)

    expect(suggestedFilename).toMatch(/\.wav$/)
    expect(bytes.byteLength).toBeGreaterThan(1000)

    // RIFF/WAVE container with fmt + data chunks.
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...bytes.subarray(off, off + len))
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(ascii(36, 4)).toBe('data')

    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(dv.getUint16(20, true), 'PCM format').toBe(1)
    const channels = dv.getUint16(22, true)
    const sampleRate = dv.getUint32(24, true)
    const blockAlign = dv.getUint16(32, true)
    const dataSize = dv.getUint32(40, true)
    expect(channels).toBeGreaterThan(0)
    expect(sampleRate).toBeGreaterThan(0)
    expect(dataSize).toBeGreaterThan(0)

    // Duration from the PCM data must be ≈ clip length (1.95s) — NOT ~3.45s.
    // This guards BUG-3: the offline render bakes a 1.5s tail that must be trimmed.
    const durationSec = dataSize / (sampleRate * blockAlign)
    expect(
      durationSec,
      `wav duration ${durationSec}s should be ≈${FIXTURE_DURATION_S}s`,
    ).toBeGreaterThan(1.6)
    expect(
      durationSec,
      `wav duration ${durationSec}s should be ≈${FIXTURE_DURATION_S}s`,
    ).toBeLessThan(2.5)
  })

  test('audio-only MP3 export is a valid MP3 (frame sync header)', async ({ page }) => {
    await loadFixtureAndOpenExport(page)

    // "Audio" destination tab; MP3 is the default format, but click it to be explicit.
    await page.locator('#export-modal .export-tab', { hasText: 'Audio' }).click()
    await page.locator('#export-modal .export-choice', { hasText: 'MP3' }).click()

    const { bytes, suggestedFilename } = await runExportAndCapture(page)

    expect(suggestedFilename).toMatch(/\.mp3$/)
    expect(bytes.byteLength).toBeGreaterThan(1000)
    // MP3 frame sync: byte0 === 0xFF and the top 3 bits of byte1 set (0xE0).
    expect(bytes[0]).toBe(0xff)
    expect(bytes[1]! & 0xe0).toBe(0xe0)
    // Compressed: should be far smaller than the equivalent WAV (~344 KB for ~2s).
    expect(bytes.byteLength).toBeLessThan(150_000)
  })
})
