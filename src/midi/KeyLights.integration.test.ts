import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MasterClock } from '../core/clock/MasterClock'
import { type MidiFile, nominalTempoMap } from '../core/midi/types'
import type { AppServices } from '../core/services'
import { createLearnState } from '../learn/core/LearnState'
import { PlayAlongEngine } from '../learn/exercises/play-along/engine'
import { KeyLights } from './KeyLights'

vi.mock('tone', () => ({
  getContext: () => ({ rawContext: { state: 'running' } }),
  start: () => Promise.resolve(),
}))

function song(): MidiFile {
  return {
    name: 'chords.mid',
    duration: 3,
    bpm: 120,
    timeSignature: [4, 4],
    ...nominalTempoMap(120, [4, 4]),
    tracks: [
      {
        id: 'piano',
        name: 'Piano',
        channel: 0,
        instrument: 0,
        isDrum: false,
        colorIndex: 0,
        notes: [
          ...[60, 64, 67].map((pitch) => ({ pitch, time: 1, duration: 0.5, velocity: 1 })),
          { pitch: 72, time: 1.06, duration: 0.5, velocity: 1 },
          { pitch: 48, time: 2, duration: 0.5, velocity: 1 },
        ],
      },
    ],
  }
}

// Model the Web MIDI boundary rather than merely spying on send(): timestamped
// messages reach the device later and immediate messages update LED state.
// The port deliberately has no clear(), like Chromium. Production must never
// submit future timestamps, because those messages cannot be cancelled.
function midiDevice() {
  const messages: number[][] = []
  const delivered: number[][] = []
  const lit = new Set<number>()
  const queue = new Set<ReturnType<typeof setTimeout>>()
  const port = {
    id: 'lights',
    name: 'KEENEKT',
    state: 'connected',
    send(data: number[], timestamp = performance.now()) {
      messages.push([...data])
      const deliver = () => {
        delivered.push([...data])
        const key = (data[0]! & 15) * 128 + data[1]!
        if ((data[0]! & 0xf0) === 0x90 && data[2]! > 0) lit.add(key)
        else lit.delete(key)
      }
      const delay = timestamp - performance.now()
      if (delay <= 0) deliver()
      else {
        const timer = setTimeout(() => {
          queue.delete(timer)
          deliver()
        }, delay)
        queue.add(timer)
      }
    },
  } as unknown as MIDIOutput
  return { messages, delivered, lit, port, queue }
}

describe('Key Lights transport/practice integration', () => {
  let clock: MasterClock
  let lights: KeyLights
  let device: ReturnType<typeof midiDevice>
  let engine: PlayAlongEngine | null
  let frameMs: number

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    localStorage.clear()
    frameMs = 16
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), frameMs),
    )
    vi.stubGlobal('cancelAnimationFrame', (timer: number) => clearTimeout(timer))
    clock = new MasterClock(() => Date.now() / 1000)
    device = midiDevice()
    lights = new KeyLights(clock)
    lights.setAccess({ outputs: new Map([[device.port.id, device.port]]) } as unknown as MIDIAccess)
    lights.configure({ outputId: device.port.id })
    engine = null
  })

  afterEach(() => {
    engine?.detach()
    lights.dispose()
    clock.dispose()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function practice() {
    const services = {
      clock,
      keyLights: lights,
      synth: { setSpeed: vi.fn(), seek: vi.fn() },
      renderer: { setPracticeTrackFocus: vi.fn() },
    } as unknown as AppServices
    engine = new PlayAlongEngine({ services, learnState: createLearnState() })
    engine.attach(song())
    engine.setWaitEnabled(true)
    engine.play()
    vi.advanceTimersByTime(Math.ceil(990 / frameMs) * frameMs)
    expect(engine.practice.isWaiting).toBe(true)
    return engine
  }

  function press(pitch: number) {
    engine!.onNoteOn({ pitch, velocity: 1, clockTime: clock.currentTime, source: 'midi' })
  }

  it('emits just one note-on per required chord key when waiting starts', () => {
    practice()
    expect(device.messages).toEqual([
      [0x90, 60, 127],
      [0x90, 64, 127],
      [0x90, 67, 127],
    ])
  })

  it('never lights a future chord when a render frame is late', () => {
    frameMs = 160
    practice()
    // Playback look-ahead used to deliver note 72 at 1.06 s, then cancel it
    // when the late frame engaged the first chord's wait at 1.12 s.
    expect(device.delivered).toEqual([
      [0x90, 60, 127],
      [0x90, 64, 127],
      [0x90, 67, 127],
    ])
  })

  it('keeps the whole chord lit without MIDI chatter after a partial answer', () => {
    practice()
    device.messages.length = 0
    press(60)
    expect(device.lit).toEqual(new Set([60, 64, 67]))
    expect(device.messages).toEqual([])
  })

  it('releases a completed chord once and never relights it during resume', () => {
    practice()
    press(60)
    press(64)
    device.messages.length = 0
    press(67)
    expect(device.messages).toEqual([
      [0x80, 60, 0],
      [0x80, 64, 0],
      [0x80, 67, 0],
    ])
    expect(device.lit.size).toBe(0)
    vi.advanceTimersByTime(80)
    expect(device.lit).toEqual(new Set([72]))
  })

  it('clears a practice wait on explicit pause and stays dark through transport changes', () => {
    const controller = practice()
    device.messages.length = 0
    controller.pause()
    clock.seek(clock.currentTime)
    clock.speed = 0.5
    vi.advanceTimersByTime(500)
    expect(device.lit.size).toBe(0)
    expect(device.messages).toEqual([
      [0x80, 60, 0],
      [0x80, 64, 0],
      [0x80, 67, 0],
    ])
  })

  it.each([
    'original',
    'track',
    'single',
    'synthesia',
  ] as const)('clears playback notes across pause positions, speeds, and timer phases (%s)', (channelMode) => {
    lights.load(song())
    lights.configure({ channelMode, channel: 16 })
    for (const speed of [0.5, 1, 2]) {
      clock.speed = speed
      for (let milliseconds = 850; milliseconds <= 1650; milliseconds += 10) {
        clock.seek(milliseconds / 1000)
        clock.play()
        vi.advanceTimersByTime(milliseconds % 26)
        clock.pause()
        const afterPause = device.messages.length
        vi.advanceTimersByTime(200)
        expect(device.lit.size, `pause at ${milliseconds} ms, speed ${speed}`).toBe(0)
        expect(device.messages).toHaveLength(afterPause)
        expect(device.queue.size).toBe(0)
      }
    }
  })

  it('repeats complete practice cycles without replaying completed chords', () => {
    const controller = practice()
    for (let cycle = 0; cycle < 20; cycle++) {
      if (cycle > 0) {
        controller.restart()
        controller.play()
        vi.advanceTimersByTime(992)
      }
      expect(device.lit).toEqual(new Set([60, 64, 67]))
      device.messages.length = 0
      const pitches = cycle % 2 === 0 ? [60, 64, 67] : [67, 60, 64]
      press(pitches[0]!)
      press(pitches[1]!)
      expect(device.messages).toEqual([])
      press(pitches[2]!)
      expect(device.messages).toEqual([
        [0x80, 60, 0],
        [0x80, 64, 0],
        [0x80, 67, 0],
      ])
      vi.advanceTimersByTime(80)
      expect(device.lit).toEqual(new Set([72]))
      press(72)
      expect(device.lit.size).toBe(0)
      vi.advanceTimersByTime(1000)
      expect(device.lit).toEqual(new Set([48]))
      press(48)
      vi.advanceTimersByTime(1200)
      expect(clock.playing).toBe(false)
      expect(device.lit.size).toBe(0)
    }
  })

  it('uses file playback only when waiting is disabled and restores normal Play after exit', () => {
    const controller = practice()
    controller.setWaitEnabled(false)
    expect(device.lit.size).toBe(0)
    controller.play()
    vi.advanceTimersByTime(40)
    expect(device.lit).toEqual(new Set([60, 64, 67]))
    controller.setWaitEnabled(true)
    expect(device.lit.size).toBe(0)
    vi.advanceTimersByTime(80)
    expect(device.lit).toEqual(new Set([72]))
    controller.detach()
    lights.load(song())
    clock.seek(1.1)
    clock.play()
    expect(device.lit).toEqual(new Set([60, 64, 67, 72]))
    clock.pause()
    expect(device.lit.size).toBe(0)
  })
})
