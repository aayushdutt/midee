// Picks the AAC encoder for the MP4 soundtrack: the browser's own (WebCodecs)
// when it has one, otherwise a WASM build of FFmpeg's AAC encoder
// (@mediabunny/aac-encoder, ~230 KB gz). The WASM chunk is dynamic-imported
// here, so only browsers that need it ever download it.
//
// Who lands where (measured 2026-09-27, docs/SAFARI_EXPORT_AUDIO_2026-09-27.md):
//   • Chrome/Edge on Mac/Windows, Safari 26+ → native. Safari's encoder emits
//     a malformed AAC description (WebKit bug 302253) that leaves the track
//     undecodable; Mediabunny's encoder wrapper repairs it, which is why
//     VideoExporter feeds an AudioSampleSource instead of driving
//     AudioEncoder itself.
//   • Safari 16.4–18.x / iOS ≤ 18 (no AudioEncoder at all), Chromium builds
//     without a platform AAC encoder → WASM (runs in a worker).
//   • null → the WASM chunk failed to load (offline, blocked). The caller
//     exports without a soundtrack and says so.
//
// Registration is global for the session and takes precedence over the
// native encoder (Mediabunny tries custom encoders first), so it only happens
// after the native probe has failed.

import { canEncodeAudio, Quality } from 'mediabunny'

export type AacEncoderKind = 'native' | 'wasm'

let wasmRegistered = false

export async function resolveAacEncoder(config: {
  sampleRate: number
  numberOfChannels: number
  bitrate: number
}): Promise<AacEncoderKind | null> {
  const probe = {
    sampleRate: config.sampleRate,
    numberOfChannels: config.numberOfChannels,
    quality: new Quality({ bitrate: config.bitrate }),
  }
  if (!wasmRegistered) {
    if (await canEncodeAudio('aac', probe)) return 'native'
    try {
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder')
      registerAacEncoder()
      wasmRegistered = true
    } catch (err) {
      console.warn('WASM AAC encoder failed to load', err)
      return null
    }
  }
  return (await canEncodeAudio('aac', probe)) ? 'wasm' : null
}
