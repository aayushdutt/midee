import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PARTICLE_STYLES } from '../renderer/particleStyles'
import { THEMES } from '../renderer/theme'
import { CustomizeMenu } from './CustomizeMenu'

vi.mock('../telemetry', () => ({ trackEvent: vi.fn() }))

describe('Appearance panel lifecycle', () => {
  let menu: CustomizeMenu
  let triggerHost: HTMLDivElement
  let panelHost: HTMLDivElement
  let frames: Map<number, FrameRequestCallback>
  let nextFrame: number

  beforeEach(() => {
    vi.useFakeTimers()
    frames = new Map()
    nextFrame = 0
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: false })),
    )
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = ++nextFrame
        frames.set(id, callback)
        return id
      }),
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => frames.delete(id)),
    )
    triggerHost = document.createElement('div')
    panelHost = document.createElement('div')
    document.body.append(triggerHost, panelHost)
    menu = new CustomizeMenu(triggerHost, panelHost, THEMES, PARTICLE_STYLES, {
      onSelectTheme: vi.fn(),
      onSelectParticle: vi.fn(),
      onToggleChord: vi.fn(),
      onToggleNoteLabels: vi.fn(),
      onSelectLocale: vi.fn(),
    })
  })

  afterEach(() => {
    menu.dispose()
    triggerHost.remove()
    panelHost.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function panel(): HTMLElement {
    return panelHost.querySelector<HTMLElement>('.ts-customize-menu')!
  }

  function advanceAnchor(): void {
    const [id, callback] = [...frames.entries()][0]!
    frames.delete(id)
    callback(16)
  }

  it('Escape closes the panel, returns focus, and stops following the anchor', () => {
    menu.trigger.click()
    expect(menu.trigger.getAttribute('aria-expanded')).toBe('true')
    expect(panel().getAttribute('aria-hidden')).toBe('false')
    expect(document.body.classList.contains('appearance-open')).toBe(true)
    expect(frames.size).toBe(1)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(menu.trigger.getAttribute('aria-expanded')).toBe('false')
    expect(panel().getAttribute('aria-hidden')).toBe('true')
    expect(document.activeElement).toBe(menu.trigger)
    expect(document.body.classList.contains('appearance-open')).toBe(false)
    expect(frames.size).toBe(0)
  })

  it('keeps the panel below a moving trigger without creating multiple frame loops', () => {
    let bottom = 80
    vi.spyOn(menu.trigger, 'getBoundingClientRect').mockImplementation(() => ({
      top: bottom - 32,
      bottom,
      left: 500,
      right: 640,
      width: 140,
      height: 32,
      x: 500,
      y: bottom - 32,
      toJSON: () => ({}),
    }))
    menu.trigger.click()
    expect(panel().style.top).toBe('88px')

    bottom = 116
    advanceAnchor()
    expect(panel().style.top).toBe('124px')
    expect(frames.size).toBe(1)
    const stableStyle = panel().getAttribute('style')
    advanceAnchor()
    expect(panel().getAttribute('style')).toBe(stableStyle)
    expect(frames.size).toBe(1)

    panel().querySelector<HTMLButtonElement>('.panel-close-btn')!.click()
    expect(frames.size).toBe(0)
    expect(document.activeElement).toBe(menu.trigger)
  })

  it('disposing immediately after opening leaves no delayed listeners, frame, or wrappers', () => {
    const addListener = vi.spyOn(document, 'addEventListener')
    menu.trigger.click()
    menu.dispose()
    const callsAtDispose = addListener.mock.calls.length
    vi.runOnlyPendingTimers()

    expect(addListener).toHaveBeenCalledTimes(callsAtDispose)
    expect(frames.size).toBe(0)
    expect(triggerHost.childElementCount).toBe(0)
    expect(panelHost.childElementCount).toBe(0)
    expect(document.body.classList.contains('appearance-open')).toBe(false)
  })
})
