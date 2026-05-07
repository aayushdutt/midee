import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createExerciseHarness, type Huddable } from './exerciseHarness'

describe('exerciseHarness', () => {
  let mountFn: ReturnType<typeof vi.fn>
  let unmountFn: ReturnType<typeof vi.fn>
  let hud: Huddable
  let host: HTMLElement

  beforeEach(() => {
    mountFn = vi.fn()
    unmountFn = vi.fn()
    hud = {
      mount: mountFn as unknown as Huddable['mount'],
      unmount: unmountFn as unknown as Huddable['unmount'],
    }
    host = document.createElement('div')
  })

  it('mountHud calls hud.mount with host and opts', () => {
    const h = createExerciseHarness({ hud, hudOpts: { foo: 1 }, onKeyDown: vi.fn() })
    h.mountHud(host)
    expect(mountFn).toHaveBeenCalledWith(host, { foo: 1 })
  })

  it('unmountHud calls hud.unmount', () => {
    const h = createExerciseHarness({ hud, hudOpts: {}, onKeyDown: vi.fn() })
    h.unmountHud()
    expect(unmountFn).toHaveBeenCalledOnce()
  })

  it('attachKeys registers the keydown listener', () => {
    const onKeyDown = vi.fn()
    const h = createExerciseHarness({ hud, hudOpts: {}, onKeyDown })
    h.attachKeys()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }))
    expect(onKeyDown).toHaveBeenCalled()
  })

  it('detachKeys removes the keydown listener', () => {
    const onKeyDown = vi.fn()
    const h = createExerciseHarness({ hud, hudOpts: {}, onKeyDown })
    h.attachKeys()
    h.detachKeys()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }))
    expect(onKeyDown).not.toHaveBeenCalled()
  })

  it('attachKeys is idempotent — calling twice does not register twice', () => {
    const onKeyDown = vi.fn()
    const h = createExerciseHarness({ hud, hudOpts: {}, onKeyDown })
    h.attachKeys()
    h.attachKeys()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }))
    expect(onKeyDown).toHaveBeenCalledTimes(1)
  })

  it('detachKeys is idempotent — calling twice does not throw', () => {
    const onKeyDown = vi.fn()
    const h = createExerciseHarness({ hud, hudOpts: {}, onKeyDown })
    h.attachKeys()
    h.detachKeys()
    expect(() => h.detachKeys()).not.toThrow()
  })

  it('attachKeys on harness without onKeyDown does nothing', () => {
    const h = createExerciseHarness({ hud, hudOpts: {} })
    expect(() => h.attachKeys()).not.toThrow()
    expect(() => h.detachKeys()).not.toThrow()
  })

  it('reattach after detach registers a fresh listener', () => {
    const onKeyDown = vi.fn()
    const h = createExerciseHarness({ hud, hudOpts: {}, onKeyDown })
    h.attachKeys()
    h.detachKeys()
    h.attachKeys()
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }))
    expect(onKeyDown).toHaveBeenCalledOnce()
  })
})
