import { expect, test } from '@playwright/test'

// SPIKE (Task I, step 2 of docs/TESTING_STRATEGY_2026-06-21.md).
//
// Goal: determine, in the actual headless Chromium Playwright drives, whether:
//   1. WebCodecs (`VideoEncoder` / `AudioEncoder`) exist at all.
//   2. H.264 encode is supported (`avc1.42E01F` baseline + `avc1.640028` high — the
//      profiles VideoExporter.pickCodec probes).
//   3. AAC audio encode is supported (`mp4a.40.2`).
//   4. A frame can actually be ENCODED (isConfigSupported can lie — this proves it).
//
// This drives the DECISION between the full export e2e (3a) and the reduced-confidence
// fallback (3b). Result is asserted AND printed so CI logs record it. This spec is
// intentionally app-independent: it probes the browser engine, not midee.

test.describe('WebCodecs headless capability spike', () => {
  test('probe VideoEncoder/AudioEncoder support + real encode', async ({ page }) => {
    // VideoEncoder/AudioEncoder are gated behind a SECURE CONTEXT in Chromium.
    // `about:blank` is NOT secure, so the constructors are undefined there. We must
    // probe from the served origin (http://localhost is treated as secure).
    await page.goto('/')
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true)

    const result = await page.evaluate(async () => {
      type Probe = {
        videoEncoderPresent: boolean
        audioEncoderPresent: boolean
        videoFramePresent: boolean
        audioDataPresent: boolean
        h264Baseline: PromiseSettledResult<unknown> | { supported?: boolean }
        h264High: { supported?: boolean } | string
        // BUG-1 probe: VideoExporter.pickCodec probes with hardwareAcceleration:
        // 'prefer-hardware' and treats a `false` as fatal. We probe BOTH the
        // prefer-hardware path (what the app actually does) and the no-preference
        // path (the software fallback the app SHOULD use) to expose the disparity.
        h264PreferHardware: { supported?: boolean } | string
        h264NoPreference: { supported?: boolean } | string
        aac: { supported?: boolean } | string
        realEncode: { ok: boolean; chunks: number; bytes: number; error?: string }
      }

      const out = {} as Probe
      out.videoEncoderPresent = typeof VideoEncoder !== 'undefined'
      out.audioEncoderPresent = typeof AudioEncoder !== 'undefined'
      out.videoFramePresent = typeof VideoFrame !== 'undefined'
      out.audioDataPresent = typeof AudioData !== 'undefined'

      const baseConfig = {
        codec: 'avc1.42E01F',
        width: 640,
        height: 480,
        bitrate: 1_000_000,
        framerate: 30,
      }
      try {
        out.h264Baseline = await VideoEncoder.isConfigSupported(baseConfig)
      } catch (e) {
        out.h264Baseline = { supported: false }
        ;(out.h264Baseline as { error?: string }).error = String(e)
      }
      try {
        out.h264High = await VideoEncoder.isConfigSupported({
          ...baseConfig,
          codec: 'avc1.640028',
        })
      } catch (e) {
        out.h264High = String(e)
      }
      // BUG-1: reproduce the app's actual probe (prefer-hardware) vs the fallback.
      try {
        out.h264PreferHardware = await VideoEncoder.isConfigSupported({
          ...baseConfig,
          hardwareAcceleration: 'prefer-hardware',
        })
      } catch (e) {
        out.h264PreferHardware = String(e)
      }
      try {
        out.h264NoPreference = await VideoEncoder.isConfigSupported({
          ...baseConfig,
          hardwareAcceleration: 'no-preference',
        })
      } catch (e) {
        out.h264NoPreference = String(e)
      }
      try {
        out.aac =
          typeof AudioEncoder !== 'undefined'
            ? await AudioEncoder.isConfigSupported({
                codec: 'mp4a.40.2',
                sampleRate: 44100,
                numberOfChannels: 2,
                bitrate: 128_000,
              })
            : 'AudioEncoder undefined'
      } catch (e) {
        out.aac = String(e)
      }

      // Real encode of a few synthetic frames — isConfigSupported can be optimistic.
      out.realEncode = { ok: false, chunks: 0, bytes: 0 }
      try {
        const W = 640
        const H = 480
        let chunks = 0
        let bytes = 0
        let err: string | undefined
        const encoder = new VideoEncoder({
          output: (chunk) => {
            chunks++
            bytes += chunk.byteLength
          },
          error: (e) => {
            err = String(e)
          },
        })
        encoder.configure({
          codec: 'avc1.42E01F',
          width: W,
          height: H,
          bitrate: 1_000_000,
          framerate: 30,
          // Don't force hardware: headless CI is software-only. Let the browser pick.
        })
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        const ctx = canvas.getContext('2d')!
        for (let i = 0; i < 5; i++) {
          ctx.fillStyle = i % 2 ? '#0af' : '#fa0'
          ctx.fillRect(0, 0, W, H)
          ctx.fillStyle = '#fff'
          ctx.fillRect(i * 40, 10, 30, 30)
          const frame = new VideoFrame(canvas, {
            timestamp: Math.round((i * 1_000_000) / 30),
          })
          encoder.encode(frame, { keyFrame: i === 0 })
          frame.close()
        }
        await encoder.flush()
        encoder.close()
        out.realEncode = { ok: chunks > 0 && !err, chunks, bytes, error: err }
      } catch (e) {
        out.realEncode = { ok: false, chunks: 0, bytes: 0, error: String(e) }
      }

      return out
    })

    // Loud record for CI logs.
    // biome-ignore lint/suspicious/noConsole: spike result must surface in CI output
    console.log('[SPIKE] WebCodecs probe:', JSON.stringify(result, null, 2))

    // Hard expectations: WebCodecs must be present. (If this fails on a CI host,
    // the export e2e must move to fallback 3b — see strategy doc.)
    expect(result.videoEncoderPresent, 'VideoEncoder present').toBe(true)
    expect(result.audioEncoderPresent, 'AudioEncoder present').toBe(true)
    expect(result.videoFramePresent, 'VideoFrame present').toBe(true)

    // Record (not hard-fail) the support flags — the full-export spec gates on the
    // real encode below.
    const h264Supported =
      (result.h264Baseline as { supported?: boolean }).supported === true ||
      (result.h264High as { supported?: boolean }).supported === true
    // biome-ignore lint/suspicious/noConsole: spike summary
    console.log(
      `[SPIKE] H.264 isConfigSupported=${h264Supported} | realEncode ok=${result.realEncode.ok} chunks=${result.realEncode.chunks} bytes=${result.realEncode.bytes}`,
    )

    // The decisive check: did a real H.264 encode produce bytes?
    expect(result.realEncode.ok, `real H.264 encode produced chunks (err: ${result.realEncode.error ?? 'none'})`).toBe(true)
    expect(result.realEncode.bytes).toBeGreaterThan(0)

    // AAC must be supported — the audio-only export path depends on it and nothing
    // else asserts it. (string result = isConfigSupported threw.)
    expect(
      (result.aac as { supported?: boolean }).supported,
      `AAC (mp4a.40.2) isConfigSupported (got: ${JSON.stringify(result.aac)})`,
    ).toBe(true)

    // BUG-1 evidence (logged, not hard-failed here — the export spec exercises the
    // real path). If prefer-hardware is unsupported but no-preference is supported,
    // VideoExporter.pickCodec's prefer-hardware-only probe is the reason AV export
    // fails for real users without a hardware encoder. We DO assert the fallback
    // path works, since that's what the fix should use.
    const preferHw = (result.h264PreferHardware as { supported?: boolean }).supported === true
    const noPref = (result.h264NoPreference as { supported?: boolean }).supported === true
    // biome-ignore lint/suspicious/noConsole: spike summary
    console.log(
      `[SPIKE][BUG-1] H.264 preferHardware=${preferHw} noPreference=${noPref} — if false/true, pickCodec must fall back to no-preference.`,
    )
    expect(
      noPref,
      'H.264 with hardwareAcceleration:no-preference must be supported (the software fallback pickCodec should use)',
    ).toBe(true)
  })
})
