import { describe, expect, it } from 'vitest'
import { pillColor, pillTop, pillWidth, pitchClassName } from './noteLabels'

describe('pitchClassName', () => {
  it('names pitches with sharps and the ♯ glyph', () => {
    expect(pitchClassName(60)).toBe('C')
    expect(pitchClassName(61)).toBe('C♯')
    expect(pitchClassName(70)).toBe('A♯')
    expect(pitchClassName(71)).toBe('B')
  })

  it('is octave-independent', () => {
    expect(pitchClassName(24)).toBe(pitchClassName(108))
    expect(pitchClassName(21)).toBe('A')
  })
})

describe('pillWidth', () => {
  it('uses the comfortable inset when the bar is wide', () => {
    // 24px white-key bar, 6px "C": pill = bar - 3px inset per side
    expect(pillWidth(6, 24, 40)).toBe(18)
  })

  it('widens past the bar edges for a two-glyph label on a black key', () => {
    // 14px black-key bar, 11.5px "F♯": needs 11.5 + 2×3 = 17.5 > preferred 8,
    // and fits within bar + 2px overhang per side = 18.
    expect(pillWidth(11.5, 14, 40)).toBe(17.5)
    // Narrower still: capped at the overhang limit, padding squeezes.
    expect(pillWidth(11.5, 11, 40)).toBe(15)
  })

  it('returns 0 when the text cannot fit with 1px padding, or the bar is short', () => {
    expect(pillWidth(11.5, 9, 40)).toBe(0)
    expect(pillWidth(6, 24, 7)).toBe(0)
  })
})

describe('pillTop', () => {
  it('sits inset above the bottom edge on tall bars', () => {
    expect(pillTop(100, 40)).toBe(100 - 4 - 14)
  })

  it('centres on the bar when there is no room to inset', () => {
    expect(pillTop(100, 20)).toBe(100 - 10 - 7)
    // Shorter than the pill: overhangs symmetrically.
    expect(pillTop(100, 8)).toBe(100 - 4 - 7)
  })
})

describe('pillColor', () => {
  it('is a darker shade of the bar colour, channel by channel', () => {
    expect(pillColor(0xffffff)).toBe(0x383838)
    expect(pillColor(0x6060ff)).toBe(0x151538)
    expect(pillColor(0x000000)).toBe(0x000000)
  })
})
