import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MasterClock } from '../core/clock/MasterClock'
import { type MidiFile, nominalTempoMap } from '../core/midi/types'
import { ModeSwitch } from '../modes/ModeSwitch'
import { createAppStore } from '../store/state'
import { renderWithApp } from '../test/renderWithApp'
import { bindPlayKeyLights } from './bindPlayKeyLights'
import { KeyLights } from './KeyLights'

vi.mock('tone', () => ({
  getContext: () => ({ rawContext: { state: 'running' } }),
  start: () => Promise.resolve(),
}))
vi.mock('../telemetry', () => ({ track: vi.fn(), trackEvent: vi.fn() }))

function song(pitch: number): MidiFile {
  return {
    name: `${pitch}.mid`,
    duration: 3,
    bpm: 120,
    timeSignature: [4, 4],
    ...nominalTempoMap(120, [4, 4]),
    tracks: [
      {
        id: 'track-0',
        name: 'Piano',
        channel: 0,
        instrument: 0,
        isDrum: false,
        colorIndex: 0,
        notes: [{ pitch, time: 0, duration: 2, velocity: 1 }],
      },
    ],
  }
}

describe('Play Key Lights source ownership', () => {
  let clock: MasterClock
  let lights: KeyLights
  let store: ReturnType<typeof createAppStore>
  let disabled: Set<string>
  let send: ReturnType<typeof vi.fn>
  let unbind: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    clock = new MasterClock(() => 0)
    lights = new KeyLights(clock)
    send = vi.fn()
    const port = {
      id: 'lights',
      name: 'KEENEKT',
      state: 'connected',
      send,
    } as unknown as MIDIOutput
    lights.setAccess({ outputs: new Map([[port.id, port]]) } as unknown as MIDIAccess)
    lights.configure({ outputId: port.id })
    store = createAppStore()
    disabled = new Set()
    unbind = bindPlayKeyLights(lights, store, () => disabled)
  })

  afterEach(() => {
    unbind()
    lights.dispose()
    clock.dispose()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('does not copy the previous song mute IDs before audio loads the new song', () => {
    store.completePlayLoad(song(60))
    disabled.add('track-0')
    lights.setTrackEnabled('track-0', false)
    // Mirrors App: completePlayLoad publishes the new file before synth.load
    // clears the old disabled IDs. New files reuse IDs such as track-0.
    store.completePlayLoad(song(64))
    disabled.clear()
    clock.play()
    expect(send).toHaveBeenCalledWith([0x90, 64, 127])
  })

  it('preserves mutes atomically on transpose and after export', () => {
    store.completePlayLoad(song(60))
    disabled.add('track-0')
    lights.setTrackEnabled('track-0', false)
    clock.play()
    send.mockClear()
    store.setTranspose(1)
    expect(send).not.toHaveBeenCalled()
    clock.pause()
    store.setState('status', 'exporting')
    clock.seek(0.5)
    store.setState('status', 'paused')
    clock.play()
    expect(send).not.toHaveBeenCalled()
  })

  it('does not reload or retrigger notes for Play/Pause status changes', () => {
    store.completePlayLoad(song(60))
    clock.play()
    send.mockClear()
    store.setState('status', 'playing')
    expect(send).not.toHaveBeenCalled()
    clock.pause()
    send.mockClear()
    store.setState('status', 'paused')
    expect(send).not.toHaveBeenCalled()
  })

  it('restores Play after the real mode switch cleans up Learn', async () => {
    const controller = {
      enter: vi.fn(() => lights.load(song(72))),
      exit: vi.fn(() => lights.load(null)),
    }
    const view = renderWithApp(() => <ModeSwitch />, {
      services: { store, clock, keyLights: lights },
      ensureLearnController: vi.fn(async () => controller) as never,
    })
    store.completePlayLoad(song(60))
    disabled.add('track-0')
    lights.setTrackEnabled('track-0', false)
    store.setState('mode', 'learn')
    await vi.waitFor(() => expect(controller.enter).toHaveBeenCalledOnce())
    store.enterPlay()
    expect(controller.exit).toHaveBeenCalledOnce()
    send.mockClear()
    clock.play()
    expect(send).not.toHaveBeenCalled()
    lights.setTrackEnabled('track-0', true)
    expect(send).toHaveBeenCalledWith([0x90, 60, 127])
    view.unmount()
  })
})
