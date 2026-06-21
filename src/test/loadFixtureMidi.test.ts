import { describe, expect, it } from 'vitest'
import { parseMidiFile } from '../core/midi/parser'
import { loadFixtureMidi, loadFixtureMidiBytes } from './loadFixtureMidi'

// Sanity: every fixture must parse cleanly so downstream tasks can rely on them.
describe('loadFixtureMidi', () => {
  it('reads a fixture into a standalone ArrayBuffer', () => {
    const buf = loadFixtureMidi('single-track.mid')
    expect(buf).toBeInstanceOf(ArrayBuffer)
    expect(buf.byteLength).toBeGreaterThan(0)
  })

  it('exposes a Uint8Array variant', () => {
    const bytes = loadFixtureMidiBytes('single-track.mid')
    expect(bytes).toBeInstanceOf(Uint8Array)
    // 'MThd' MIDI header chunk magic.
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x4d, 0x54, 0x68, 0x64])
  })

  it('single-track.mid parses to one non-drum track with the C scale', async () => {
    const midi = await parseMidiFile(loadFixtureMidi('single-track.mid'), 'single')
    expect(midi.tracks).toHaveLength(1)
    expect(midi.tracks[0]?.isDrum).toBe(false)
    expect(midi.tracks[0]?.notes[0]?.pitch).toBe(60)
    expect(midi.bpm).toBeCloseTo(120, 0)
  })

  it('multi-track.mid parses to two melodic tracks', async () => {
    const midi = await parseMidiFile(loadFixtureMidi('multi-track.mid'), 'multi')
    expect(midi.tracks).toHaveLength(2)
    expect(midi.tracks.every((t) => !t.isDrum)).toBe(true)
  })

  it('drum-track.mid parses with a channel-9 track flagged isDrum', async () => {
    const midi = await parseMidiFile(loadFixtureMidi('drum-track.mid'), 'drums')
    expect(midi.tracks).toHaveLength(2)
    const drum = midi.tracks.find((t) => t.isDrum)
    expect(drum).toBeDefined()
    expect(drum?.channel).toBe(9)
  })
})
