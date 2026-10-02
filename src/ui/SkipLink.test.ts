import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSkipLink } from './SkipLink'

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(content: string): HTMLAnchorElement {
  document.body.innerHTML = `<a class="skip-link" href="#app">Skip</a><main id="app" tabindex="-1">${content}</main>`
  return document.querySelector<HTMLAnchorElement>('.skip-link')!
}

describe('skip link', () => {
  it('bypasses navigation and focuses the home action without changing the fragment', () => {
    const link = mount(
      '<button id="ts-home">Home</button><button id="home-open">Open MIDI</button>',
    )
    installSkipLink(() => 'home')
    link.click()
    expect(document.activeElement?.id).toBe('home-open')
    expect(window.location.hash).toBe('')
  })

  it('uses the current mode and prioritizes the playback action over HUD chrome', () => {
    const link = mount(
      '<div id="hud"><button id="hud-drag">Drag</button><button id="hud-play">Play</button><button id="hud-metro">Metronome</button></div>',
    )
    let mode: 'play' | 'live' = 'play'
    installSkipLink(() => mode)
    link.click()
    expect(document.activeElement?.id).toBe('hud-play')
    mode = 'live'
    link.click()
    expect(document.activeElement?.id).toBe('hud-metro')
  })

  it('focuses the main landmark while mode controls are unavailable', () => {
    const link = mount('')
    installSkipLink(() => 'learn')
    link.click()
    expect(document.activeElement?.id).toBe('app')
  })

  it('does not let musical global shortcuts consume keys while the link is focused', () => {
    const link = mount('')
    installSkipLink(() => 'home')
    const globalShortcut = vi.fn()
    window.addEventListener('keydown', globalShortcut)
    try {
      link.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH', bubbles: true }))
      expect(globalShortcut).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', globalShortcut)
    }
  })
})
