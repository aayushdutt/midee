// In-page decode of an exported MP4 for e2e assertions — "does it actually
// play?", which the box-level checks in ./mp4.ts can't answer. Mediabunny (the
// app's own muxer library; the prod bundle doesn't expose it, so its ESM bundle
// is served from node_modules on a routed URL) demuxes, and the browser's
// WebCodecs decoders decode — the path a Chromium-based player takes. Pixels
// and samples stay in the page; only small summaries cross back to Node.
//
// Frame fidelity: installFrameSnapshots() wraps `VideoFrame` so every canvas
// frame the exporter hands to the encoder is also downscaled into a snapshot,
// keyed by timestamp. decodeExport() then scores each decoded frame against the
// snapshot of the same index and its neighbours, so a stale (N shows N-1),
// black, cropped or colour-shifted frame shows up whatever the capture path is.
// No golden images: particles are random and history-dependent.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

const THUMB = { width: 128, height: 72 }
const MEDIABUNNY_PATH = fileURLToPath(
  new URL('../../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs', import.meta.url),
)
const MEDIABUNNY_URL = '/__e2e/mediabunny.mjs'
const EXPORT_URL = '/__e2e/export.mp4'

/** PSNR in dB (99 = identical) of one decoded frame against canvas snapshots. */
export interface FrameScore {
  t: number
  own: number // vs the snapshot of the same frame
  prev: number | null // vs the previous frame's snapshot
  next: number | null // vs the next frame's snapshot
  motion: number | null // this snapshot vs the previous one: how much the scene moved
}

export interface DecodedExport {
  video: {
    width: number
    height: number
    timestamps: number[] // seconds, presentation order
    snapshots: number // canvas snapshots captured during the export
    scores: FrameScore[] // empty when no snapshots were captured
    // Per frame: mean absolute RGB change (0–255) of the bottom strip — the
    // keyboard — against the first frame. Jumps when a key lights up.
    keyboardActivity: number[]
  }
  audio: {
    sampleRate: number
    channels: number
    duration: number // seconds of decoded audio
    rmsDb: number // dBFS over all channels
    onset: number | null // seconds: first sample reaching 10 % of the peak
  } | null
}

// Box-filters RGBA pixels down to w×h. Both sides of the fidelity comparison go
// through this one function (injected into the page as source): the browser's
// canvas downscaler and Mediabunny's frame downscaler filter differently, and
// on the keyboard's fine key pattern that alone cost ~10 dB of PSNR.
function thumbnail(
  px: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * srcH) / h)
    const y1 = Math.floor(((y + 1) * srcH) / h)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * srcW) / w)
      const x1 = Math.floor(((x + 1) * srcW) / w)
      let r = 0
      let g = 0
      let b = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcW + sx) * 4
          r += px[i]!
          g += px[i + 1]!
          b += px[i + 2]!
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * w + x) * 4
      out[o] = r / n
      out[o + 1] = g / n
      out[o + 2] = b / n
      out[o + 3] = 255
    }
  }
  return out
}
const THUMBNAIL_SRC = thumbnail.toString()

/** Call before `page.goto`: snapshot every canvas frame the exporter encodes. */
export async function installFrameSnapshots(page: Page): Promise<void> {
  await page.addInitScript(
    ({ thumb, thumbnailSrc }) => {
      const Original = globalThis.VideoFrame
      if (!Original) return
      const shrink = new Function(`return (${thumbnailSrc})`)() as typeof thumbnail
      const snaps = new Map<number, Uint8ClampedArray>()
      ;(globalThis as { __e2eSnaps?: typeof snaps }).__e2eSnaps = snaps
      let ctx: OffscreenCanvasRenderingContext2D | null = null
      globalThis.VideoFrame = new Proxy(Original, {
        construct(target, args, newTarget) {
          const [source, init] = args as [unknown, { timestamp?: number } | undefined]
          // Same task as the render, so the WebGL drawing buffer is still intact.
          if (source instanceof HTMLCanvasElement && typeof init?.timestamp === 'number') {
            const { width, height } = source
            if (ctx?.canvas.width !== width || ctx.canvas.height !== height) {
              ctx = new OffscreenCanvas(width, height).getContext('2d', {
                willReadFrequently: true,
              })!
            }
            ctx.drawImage(source, 0, 0)
            const px = ctx.getImageData(0, 0, width, height).data
            snaps.set(init.timestamp, shrink(px, width, height, thumb.width, thumb.height))
          }
          return Reflect.construct(target, args, newTarget)
        },
      })
    },
    { thumb: THUMB, thumbnailSrc: THUMBNAIL_SRC },
  )
}

export async function decodeExport(
  page: Page,
  bytes: Uint8Array,
  keyboardStrip = 0.08,
): Promise<DecodedExport> {
  const mediabunny = await readFile(MEDIABUNNY_PATH)
  await page.route(`**${MEDIABUNNY_URL}`, (r) =>
    r.fulfill({ contentType: 'text/javascript', body: mediabunny }),
  )
  await page.unroute(`**${EXPORT_URL}`)
  await page.route(`**${EXPORT_URL}`, (r) =>
    r.fulfill({ contentType: 'video/mp4', body: Buffer.from(bytes) }),
  )

  return page.evaluate(
    async ({ mediabunnyUrl, exportUrl, thumb, strip, thumbnailSrc }) => {
      const M: typeof import('mediabunny') = await import(mediabunnyUrl)
      const shrink = new Function(`return (${thumbnailSrc})`)() as typeof thumbnail
      const data = await (await fetch(exportUrl)).arrayBuffer()
      const input = new M.Input({ source: new M.BufferSource(data), formats: M.ALL_FORMATS })

      const psnr = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
        let se = 0
        for (let i = 0; i < a.length; i += 4) {
          for (let c = 0; c < 3; c++) se += (a[i + c]! - b[i + c]!) ** 2
        }
        return se === 0 ? 99 : 10 * Math.log10((255 * 255) / (se / ((a.length / 4) * 3)))
      }

      // ── video ──
      const track = await input.getPrimaryVideoTrack()
      if (!track) throw new Error('export has no video track')
      const snapMap = (globalThis as { __e2eSnaps?: Map<number, Uint8ClampedArray> }).__e2eSnaps
      const snaps = [...(snapMap ?? new Map())].sort((a, b) => a[0] - b[0]).map(([, px]) => px)
      const stripFrom = Math.floor(thumb.height * (1 - strip)) * thumb.width * 4
      const timestamps: number[] = []
      const scores: {
        t: number
        own: number
        prev: number | null
        next: number | null
        motion: number | null
      }[] = []
      const keyboardActivity: number[] = []
      let first: Uint8ClampedArray | null = null
      // Full-resolution frames, shrunk by the same filter as the snapshots.
      for await (const { canvas, timestamp } of new M.CanvasSink(track).canvases()) {
        const { width, height } = canvas
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
        const px = shrink(
          ctx.getImageData(0, 0, width, height).data,
          width,
          height,
          thumb.width,
          thumb.height,
        )
        const i = timestamps.length
        timestamps.push(timestamp)
        first ??= px
        let change = 0
        for (let k = stripFrom; k < px.length; k += 4) {
          for (let c = 0; c < 3; c++) change += Math.abs(px[k + c]! - first[k + c]!)
        }
        keyboardActivity.push(change / (((px.length - stripFrom) / 4) * 3))
        const own = snaps[i]
        if (own) {
          const prev = snaps[i - 1]
          const next = snaps[i + 1]
          scores.push({
            t: timestamp,
            own: psnr(px, own),
            prev: prev ? psnr(px, prev) : null,
            next: next ? psnr(px, next) : null,
            motion: prev ? psnr(own, prev) : null,
          })
        }
      }

      // ── audio ──
      let audio = null
      const audioTrack = await input.getPrimaryAudioTrack()
      if (audioTrack) {
        const buffers: { buffer: AudioBuffer; timestamp: number }[] = []
        for await (const b of new M.AudioBufferSink(audioTrack).buffers()) buffers.push(b)
        let sumSq = 0
        let count = 0
        let peak = 0
        for (const { buffer } of buffers) {
          for (let c = 0; c < buffer.numberOfChannels; c++) {
            for (const x of buffer.getChannelData(c)) {
              sumSq += x * x
              count++
              peak = Math.max(peak, Math.abs(x))
            }
          }
        }
        let onset: number | null = null
        search: for (const { buffer, timestamp } of buffers) {
          for (let s = 0; s < buffer.length; s++) {
            for (let c = 0; c < buffer.numberOfChannels; c++) {
              if (peak > 0 && Math.abs(buffer.getChannelData(c)[s]!) >= 0.1 * peak) {
                onset = timestamp + s / buffer.sampleRate
                break search
              }
            }
          }
        }
        audio = {
          sampleRate: audioTrack.sampleRate,
          channels: audioTrack.numberOfChannels,
          duration: buffers.reduce((sum, b) => sum + b.buffer.duration, 0),
          rmsDb: 10 * Math.log10(sumSq / Math.max(1, count) + 1e-20),
          onset,
        }
      }

      return {
        video: {
          width: track.displayWidth,
          height: track.displayHeight,
          timestamps,
          snapshots: snaps.length,
          scores,
          keyboardActivity,
        },
        audio,
      }
    },
    {
      mediabunnyUrl: MEDIABUNNY_URL,
      exportUrl: EXPORT_URL,
      thumb: THUMB,
      strip: keyboardStrip,
      thumbnailSrc: THUMBNAIL_SRC,
    },
  )
}
