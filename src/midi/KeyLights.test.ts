import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MasterClock } from '../core/clock/MasterClock'
import { type MidiFile, nominalTempoMap } from '../core/midi/types'
import { KeyLights } from './KeyLights'

vi.mock('tone', () => ({
  getContext: () => ({ rawContext: { state: 'running' } }),
  start: () => Promise.resolve(),
}))

function file(): MidiFile {
  return {
    name: 'lights.mid',
    duration: 3,
    bpm: 120,
    timeSignature: [4, 4],
    ...nominalTempoMap(120, [4, 4]),
    tracks: [
      {
        id: 'right',
        name: 'Right',
        channel: 2,
        instrument: 0,
        isDrum: false,
        colorIndex: 0,
        notes: [{ pitch: 60, velocity: 0.5, time: 0.05, duration: 0.1, releaseAt: 3 }],
      },
      {
        id: 'left',
        name: 'Left',
        channel: 4,
        instrument: 0,
        isDrum: false,
        colorIndex: 1,
        notes: [{ pitch: 48, velocity: 1, time: 0.06, duration: 0.02 }],
      },
    ],
  }
}

describe('Key Lights MIDI output', () => {
  let now: number
  let clock: MasterClock
  let lights: KeyLights
  let port: MIDIOutput
  let send: ReturnType<typeof vi.fn>
  let clear: ReturnType<typeof vi.fn>
  let access: MIDIAccess

  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    now = 0
    clock = new MasterClock(() => now)
    send = vi.fn()
    clear = vi.fn()
    port = { id: 'keezi', name: 'KEEZI', state: 'connected', send, clear } as unknown as MIDIOutput
    access = { outputs: new Map([[port.id, port]]) } as unknown as MIDIAccess
    lights = new KeyLights(clock)
    lights.setAccess(access)
    lights.load(file())
  })

  afterEach(() => {
    lights.dispose()
    clock.dispose()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function enable(): void {
    lights.configure({ outputId: 'keezi' })
    send.mockClear()
    clear.mockClear()
  }

  function advance(time: number): void {
    now = time
    vi.advanceTimersByTime(25)
  }

  it('keeps output opt-in, including when a device is already connected', () => {
    clock.play()
    advance(0.1)
    expect(send).not.toHaveBeenCalled()
    expect(lights.status.value).toBe('off')
    expect(lights.outputs.value).toEqual([{ id: 'keezi', name: 'KEEZI' }])
  })

  it('schedules note on/off on the original channels, including short notes', () => {
    enable()
    clock.play()
    expect(send.mock.calls.map(([data]) => data)).toEqual([
      [0x92, 60, 64],
      [0x94, 48, 127],
      [0x84, 48, 0],
    ])
    const timestamps = send.mock.calls.map(([, timestamp]) => timestamp as number)
    expect(timestamps[1]! - timestamps[0]!).toBeCloseTo(10)
    expect(timestamps[2]! - timestamps[0]!).toBeCloseTo(30)
    advance(0.1)
    expect(send).toHaveBeenLastCalledWith([0x82, 60, 0], expect.any(Number))
  })

  it('cancels queued events and explicitly releases every touched light on pause', () => {
    enable()
    clock.play()
    send.mockClear()
    clock.pause()
    expect(clear).toHaveBeenCalled()
    expect(send.mock.calls.map(([data]) => data)).toEqual([
      [0x82, 60, 0],
      [0x84, 48, 0],
    ])
    send.mockClear()
    advance(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('rebuilds held notes on seeks and clears lights when seeking past them', () => {
    enable()
    clock.play()
    send.mockClear()
    clock.seek(0.1)
    expect(send).toHaveBeenCalledWith([0x92, 60, 64], undefined)
    send.mockClear()
    clock.seek(2)
    expect(send.mock.calls.every(([data]) => (data[0] & 0xf0) === 0x80)).toBe(true)
  })

  it('assigns one channel per track or a single channel from 1–16', () => {
    enable()
    lights.configure({ channelMode: 'track' })
    clock.play()
    expect(send).toHaveBeenCalledWith([0x90, 60, 64], expect.any(Number))
    expect(send).toHaveBeenCalledWith([0x91, 48, 127], expect.any(Number))
    lights.configure({ channelMode: 'single', channel: 16 })
    expect(send).toHaveBeenCalledWith([0x9f, 60, 64], expect.any(Number))
  })

  it('reschedules timestamps at the new playback speed', () => {
    enable()
    clock.play()
    send.mockClear()
    clock.speed = 0.5
    const on = send.mock.calls.find(([data]) => data[0] === 0x92)!
    expect(on[1] - performance.now()).toBeCloseTo(100)
  })

  it('uses Synthesia unknown-finger channels 12/13 for inferred left/right tracks', () => {
    enable()
    lights.configure({ channelMode: 'synthesia' })
    clock.play()
    expect(send).toHaveBeenCalledWith([0x9c, 60, 64], expect.any(Number))
    expect(send).toHaveBeenCalledWith([0x9b, 48, 127], expect.any(Number))
    advance(0.1)
    expect(send).toHaveBeenCalledWith([0x8c, 60, 0], expect.any(Number))
  })

  it('splits a single-track file at middle C for the Synthesia hand preset', () => {
    const midi = file()
    midi.tracks[0]!.notes.push(...midi.tracks[1]!.notes)
    midi.tracks = [midi.tracks[0]!]
    lights.load(midi)
    enable()
    lights.configure({ channelMode: 'synthesia' })
    clock.play()
    expect(send).toHaveBeenCalledWith([0x9c, 60, 64], expect.any(Number))
    expect(send).toHaveBeenCalledWith([0x9b, 48, 127], expect.any(Number))
  })

  it('keeps overlapping notes lit until their final note-off', () => {
    const midi = file()
    midi.tracks = [midi.tracks[0]!]
    midi.tracks[0]!.notes.push({ pitch: 60, velocity: 1, time: 0.1, duration: 0.2 })
    lights.load(midi)
    enable()
    clock.play()
    advance(0.1)
    expect(send.mock.calls.filter(([data]) => data[0] === 0x92)).toHaveLength(1)
    expect(send.mock.calls.filter(([data]) => data[0] === 0x82)).toHaveLength(0)
    advance(0.25)
    expect(send).toHaveBeenLastCalledWith([0x82, 60, 0], expect.any(Number))
  })

  it('clears muted tracks immediately and skips drums', () => {
    const midi = file()
    midi.tracks[1]!.isDrum = true
    lights.load(midi)
    enable()
    clock.play()
    expect(send).not.toHaveBeenCalledWith([0x94, 48, 127], expect.any(Number))
    send.mockClear()
    lights.setTrackEnabled('right', false)
    expect(send).toHaveBeenCalledWith([0x82, 60, 0])
    expect(send.mock.calls.every(([data]) => (data[0] & 0xf0) === 0x80)).toBe(true)
  })

  it('updates guidance incrementally and keeps it stable during transport transitions', () => {
    enable()
    const note = { pitch: 64, velocity: 0.8, channel: 1, trackIndex: 0 }
    lights.setGuidance([note])
    expect(send).toHaveBeenCalledWith([0x91, 64, 102], undefined)
    send.mockClear()
    clock.play()
    clock.pause()
    lights.setGuidance([{ ...note }])
    expect(send).not.toHaveBeenCalled()
    lights.setGuidance([])
    expect(send).toHaveBeenLastCalledWith([0x81, 64, 0], undefined)
    lights.load(null)
  })

  it('reconnects only the selected device and contains send failures', () => {
    enable()
    clock.play()
    ;(port as unknown as { state: string }).state = 'disconnected'
    lights.setAccess(access)
    expect(lights.status.value).toBe('disconnected')
    expect(lights.outputs.value).toEqual([])
    send.mockClear()
    advance(0.01)
    expect(send).not.toHaveBeenCalled()
    ;(port as unknown as { state: string }).state = 'connected'
    lights.setAccess(access)
    expect(lights.status.value).toBe('connected')
    send.mockImplementation(() => {
      throw new Error('Device disconnected')
    })
    expect(() => clock.seek(0)).not.toThrow()
    expect(lights.status.value).toBe('error')
  })

  it('turns off queued and active lights on page exit and disposal', () => {
    enable()
    clock.play()
    send.mockClear()
    window.dispatchEvent(new Event('pagehide'))
    expect(clear).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith([0x82, 60, 0])
    lights.dispose()
    send.mockClear()
    clock.seek(0)
    expect(send).not.toHaveBeenCalled()
  })
})
