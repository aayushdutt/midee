import { fireEvent, render, screen } from '@solidjs/testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MasterClock } from '../core/clock/MasterClock'
import { KeyLights } from '../midi/KeyLights'
import { MidiInputManager } from '../midi/MidiInputManager'
import { KeyLightsSettings } from './KeyLightsSettings'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Key Lights settings', () => {
  it('retains the selected device through output refreshes and reconnects', () => {
    vi.stubGlobal('navigator', { requestMIDIAccess: vi.fn() })
    const clock = { subscribeTransport: () => () => {}, playing: false } as unknown as MasterClock
    const lights = new KeyLights(clock)
    const midiInput = new MidiInputManager(clock)
    const output = {
      id: 'keezi',
      name: 'KEEZI',
      state: 'connected',
      clear: vi.fn(),
      send: vi.fn(),
    }
    const access = { outputs: new Map([[output.id, output]]) } as unknown as MIDIAccess
    const view = render(() => <KeyLightsSettings lights={lights} midiInput={midiInput} />)
    lights.setAccess(access)
    midiInput.midiAccess.set(access)
    const device = screen.getByLabelText('Light device') as HTMLSelectElement
    fireEvent.change(device, { target: { value: 'keezi' } })
    expect(lights.settings.value.outputId).toBe('keezi')
    expect(device.value).toBe('keezi')
    fireEvent.change(screen.getByLabelText('Colors'), { target: { value: 'single' } })
    expect(device.value).toBe('keezi')
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: '16' } })
    expect(lights.settings.value.channel).toBe(16)
    output.state = 'disconnected'
    lights.setAccess(access)
    expect(device.value).toBe('keezi')
    expect(device.selectedOptions[0]!.textContent).toBe('Device disconnected')
    output.state = 'connected'
    lights.setAccess(access)
    expect(device.value).toBe('keezi')
    expect(device.selectedOptions[0]!.textContent).toBe('KEEZI')
    fireEvent.change(device, { target: { value: '' } })
    expect(lights.status.value).toBe('off')
    lights.dispose()
    view.unmount()
  })

  it('explains unavailable MIDI output in unsupported browsers', () => {
    vi.stubGlobal('navigator', {})
    const clock = { subscribeTransport: () => () => {} } as unknown as MasterClock
    const lights = new KeyLights(clock)
    const midiInput = new MidiInputManager(clock)
    const view = render(() => <KeyLightsSettings lights={lights} midiInput={midiInput} />)
    expect(screen.getByRole('status').textContent).toContain('Try Chrome or Edge on desktop')
    expect(screen.queryByLabelText('Light device')).toBeNull()
    lights.dispose()
    view.unmount()
  })
})
