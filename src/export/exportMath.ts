// Pure math/resolution helpers for the export pipeline.
//
// Extracted verbatim from `app.ts` (the orchestrator) so this risk-bearing
// logic — pitch-range fitting, audio-tail trimming, and dimension/bitrate
// resolution — can be unit-tested without spinning up the full `App` class or a
// browser AudioContext. `app.ts` re-imports these; there is intentionally no
// behavioral change.

import type { MidiFile } from '../core/midi/types'
import type { ExportResolution, ExportSpeed } from '../ui/ExportModal'

// Scans the MIDI's notes for min/max pitch and pads outward by a few keys so
// the visible range feels natural rather than clipping right at the extremes.
// Clamps to the MIDI-usable octaves on 88-key piano.
export function fitPitchRange(midi: MidiFile): { min: number; max: number } {
  let lo = 108,
    hi = 21
  for (const track of midi.tracks) {
    for (const n of track.notes) {
      if (n.pitch < lo) lo = n.pitch
      if (n.pitch > hi) hi = n.pitch
    }
  }
  if (hi < lo) return { min: 21, max: 108 }
  // Pad ~3 semitones each side; widen if the range is tiny so cards don't
  // look like a single-octave slice on a half-chorused piece.
  const pad = Math.max(3, Math.round((hi - lo) * 0.12))
  return {
    min: Math.max(21, lo - pad),
    max: Math.min(108, hi + pad),
  }
}

export function speedToPps(speed: ExportSpeed): number {
  switch (speed) {
    case 'compact':
      return 300
    case 'standard':
      return 200
    case 'drama':
      return 120
  }
}

// Pure sample-count math behind `trimAudioBuffer`. Returns the frame count the
// trimmed buffer should have for `durationSec`, or `null` when the source is
// already at/under that length (caller returns the source untouched — no copy).
//
// Floors at 1 frame so a zero/negative duration never yields an empty buffer.
// Uses `Math.ceil` so the trimmed audio is never SHORTER than the requested
// duration (a half-sample short cut would clip the final note's tail).
export function trimmedFrameCount(
  durationSec: number,
  sampleRate: number,
  sourceLength: number,
): number | null {
  const targetFrames = Math.max(1, Math.ceil(durationSec * sampleRate))
  if (targetFrames >= sourceLength) return null
  return targetFrames
}

export function trimAudioBuffer(audio: AudioBuffer, durationSec: number): AudioBuffer {
  const targetFrames = trimmedFrameCount(durationSec, audio.sampleRate, audio.length)
  if (targetFrames === null) return audio

  const trimmed = new AudioBuffer({
    length: targetFrames,
    numberOfChannels: audio.numberOfChannels,
    sampleRate: audio.sampleRate,
  })

  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    trimmed.copyToChannel(audio.getChannelData(ch).subarray(0, targetFrames), ch)
  }

  return trimmed
}

// Stable string for an active-pitch set so the chord overlay can short-circuit
// recomputation when nothing changed between frames.
export function pitchSignature(pitches: Set<number>): string {
  if (pitches.size === 0) return ''
  return Array.from(pitches)
    .sort((a, b) => a - b)
    .join('.')
}

// Resolves a user-facing resolution preset to concrete pixel dimensions.
// Returns `null` when the preset means "keep whatever the canvas currently is"
// so the caller can skip the resize entirely.
export function resolveExportDims(
  preset: ExportResolution,
): { width: number; height: number } | null {
  switch (preset) {
    case '720p':
      return { width: 1280, height: 720 }
    case '1080p':
      return { width: 1920, height: 1080 }
    case '2k':
      return { width: 2560, height: 1440 }
    case '4k':
      return { width: 3840, height: 2160 }
    case 'vertical':
      return { width: 1080, height: 1920 }
    case 'square':
      return { width: 1080, height: 1080 }
    case 'match':
      return null
  }
}

// H.264 bitrate per preset. Lower than YouTube's recommendations but tuned
// for visual fidelity of a piano-roll (mostly dark background, few gradients)
// — the encoder doesn't need YouTube's overhead for live-action footage.
export function resolveExportBitrate(preset: ExportResolution): number {
  switch (preset) {
    case '720p':
      return 5_000_000
    case '1080p':
      return 8_000_000
    case '2k':
      return 16_000_000
    case '4k':
      return 35_000_000
    case 'vertical':
      return 8_000_000
    case 'square':
      return 5_000_000
    case 'match':
      return 8_000_000
  }
}
