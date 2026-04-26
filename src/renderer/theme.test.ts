import { describe, expect, it } from 'vitest'
import type { MidiTrack } from '../core/midi/types'
import { getTrackColor, THEMES } from './theme'

const track = (colorIndex: number): MidiTrack => ({
  id: 't',
  name: 't',
  channel: 0,
  instrument: 0,
  isDrum: false,
  notes: [],
  color: 0,
  colorIndex,
})

describe('getTrackColor', () => {
  // The TrackPanel swatch resolves through this function so the dropdown
  // colour matches the on-canvas note. If this drifts, swatches lie about
  // which track is which — the bug we just fixed.
  it.each(THEMES)('returns the theme palette colour for $name', (theme) => {
    for (let i = 0; i < theme.trackColors.length; i++) {
      expect(getTrackColor(track(i), theme)).toBe(theme.trackColors[i])
    }
  })

  it('wraps colorIndex past the palette length so a 9th track still gets a colour', () => {
    const theme = THEMES[0]!
    const len = theme.trackColors.length
    expect(getTrackColor(track(len), theme)).toBe(theme.trackColors[0])
    expect(getTrackColor(track(len + 3), theme)).toBe(theme.trackColors[3])
  })
})
