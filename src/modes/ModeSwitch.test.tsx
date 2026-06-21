import { describe, expect, it } from 'vitest'
import { renderWithApp } from '../test/renderWithApp'
import { ModeSwitch } from './ModeSwitch'

// ModeSwitch is the reactive router for the four app modes. It reads
// `store.state.mode` inside a <Switch> and swaps the rendered surface when the
// store changes. It calls `useApp()`, so it needs the harness. These tests use
// the harness's REAL store to prove reactive re-rendering on mode changes — the
// core value of wiring a real store into the fake ctx.
//
// Note: the project `.env` sets VITE_ENABLE_LEARN_MODE=true, so `learn` resolves
// to the full <LearnMode> branch (which awaits ensureLearnController), not the
// coming-soon fallback. We assert on the side effects each branch drives through
// the fake ctx, since the mode surfaces themselves render null.
describe('ModeSwitch', () => {
  it('renders without throwing on useApp() inside the harness', () => {
    expect(() => renderWithApp(() => <ModeSwitch />)).not.toThrow()
  })

  it('mounts the home surface by default and resets interaction state', () => {
    // Default store mode is 'home' → HomeMode mounts and runs its reset path.
    const { ctx } = renderWithApp(() => <ModeSwitch />)
    expect(ctx.resetInteractionState).toHaveBeenCalledOnce()
    expect(ctx.services.renderer.clearMidi).toHaveBeenCalledOnce()
    expect(ctx.dropzone.show).toHaveBeenCalledOnce()
  })

  it('reactively swaps to the learn surface when the store mode changes', () => {
    const { ctx } = renderWithApp(() => <ModeSwitch />)
    expect(ctx.ensureLearnController).not.toHaveBeenCalled()
    // Flipping mode → 'learn' must remount the Switch branch into LearnMode,
    // whose onMount awaits the dynamic-imported controller.
    ctx.store.setState({ mode: 'learn' })
    expect(ctx.ensureLearnController).toHaveBeenCalledOnce()
  })

  it('routes to the file picker when entering play with no MIDI loaded', () => {
    const { ctx } = renderWithApp(() => <ModeSwitch />)
    // PlayMode.onMount with status='ready' (default) + no loadedMidi opens the
    // picker rather than rendering a stale surface.
    ctx.store.setState({ mode: 'play' })
    expect(ctx.openFilePicker).toHaveBeenCalledOnce()
  })

  it('does not open the picker when play mode has a loaded MIDI', () => {
    const { ctx } = renderWithApp(() => <ModeSwitch />)
    ctx.store.completePlayLoad({
      name: 'demo.mid',
      duration: 12,
      tracks: [],
    } as never)
    // completePlayLoad sets mode='play' + loadedMidi, so PlayMode renders the
    // file instead of bouncing to the picker.
    expect(ctx.store.state.mode).toBe('play')
    expect(ctx.openFilePicker).not.toHaveBeenCalled()
    expect(ctx.services.renderer.loadMidi).toHaveBeenCalledOnce()
  })
})
