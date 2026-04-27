import { describe, expect, it, vi } from 'vitest'
import type { MasterClock } from '../../core/clock/MasterClock'
import type { MidiFile } from '../../core/midi/types'
import { PracticeEngine } from './PracticeEngine'

function makeClock() {
  const listeners = new Set<(t: number) => void>()
  let t = 0
  return {
    get currentTime() {
      return t
    },
    emit(newT: number) {
      t = newT
      for (const fn of listeners) fn(newT)
    },
    pause: vi.fn(),
    play: vi.fn(),
    seek: vi.fn((newT: number) => {
      t = Math.max(0, newT)
      for (const fn of listeners) fn(t)
    }),
    subscribe(fn: (t: number) => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

function midiWithNotes(notes: Array<{ pitch: number; time: number }>): MidiFile {
  return {
    name: 'early.mid',
    duration: 10,
    bpm: 120,
    timeSignature: [4, 4],
    tracks: [
      {
        id: 'rh',
        name: 'Right',
        channel: 0,
        instrument: 0,
        isDrum: false,
        color: 0xffffff,
        colorIndex: 0,
        notes: notes.map((note) => ({
          ...note,
          duration: 0.5,
          velocity: 1,
        })),
      },
    ],
  }
}

function makeEngine(midi: MidiFile = midiWithNotes([{ pitch: 60, time: 2 }])) {
  const clock = makeClock()
  const onWaitStart = vi.fn()
  const onWaitEnd = vi.fn()
  const engine = new PracticeEngine(clock as unknown as MasterClock, { onWaitStart, onWaitEnd })
  engine.loadMidi(midi)
  engine.setEnabled(true)
  return { clock, engine, onWaitStart, onWaitEnd }
}

describe('PracticeEngine early note acceptance', () => {
  it('accepts the next step when played slightly before the target time', () => {
    const { clock, engine, onWaitStart, onWaitEnd } = makeEngine()

    clock.emit(1.9)
    const outcome = engine.notePressed(60)

    expect(outcome.kind).toBe('advanced')
    expect(onWaitStart).toHaveBeenCalledOnce()
    expect(onWaitEnd).toHaveBeenCalledWith(2.006)
    expect(engine.isWaiting).toBe(false)
  })

  it('does not accept a matching note outside the early window', () => {
    const { clock, engine, onWaitStart, onWaitEnd } = makeEngine()

    clock.emit(1.87)
    const outcome = engine.notePressed(60)

    expect(outcome.kind).toBe('rejected')
    expect(onWaitStart).not.toHaveBeenCalled()
    expect(onWaitEnd).not.toHaveBeenCalled()
    expect(engine.isWaiting).toBe(false)
  })

  it('does not punish a wrong early note by entering wait mode', () => {
    const { clock, engine, onWaitStart, onWaitEnd } = makeEngine()

    clock.emit(1.9)
    const outcome = engine.notePressed(61)

    expect(outcome.kind).toBe('rejected')
    expect(onWaitStart).not.toHaveBeenCalled()
    expect(onWaitEnd).not.toHaveBeenCalled()
    expect(engine.isWaiting).toBe(false)
  })

  it('keeps early chord notes accepted until the chord is completed', () => {
    const { clock, engine, onWaitStart, onWaitEnd } = makeEngine(
      midiWithNotes([
        { pitch: 60, time: 2 },
        { pitch: 64, time: 2 },
      ]),
    )

    clock.emit(1.9)
    expect(engine.notePressed(60).kind).toBe('accepted')
    expect(engine.isWaiting).toBe(true)
    expect(engine.status.value.pending).toEqual(new Set([64]))
    expect(engine.status.value.accepted).toEqual(new Set([60]))

    expect(engine.notePressed(64).kind).toBe('advanced')
    expect(onWaitStart).toHaveBeenCalledOnce()
    expect(onWaitEnd).toHaveBeenCalledWith(2.006)
    expect(engine.isWaiting).toBe(false)
  })

  it('does not engage a due wait when filtering tracks while disabled', () => {
    const { clock, engine, onWaitStart } = makeEngine()

    engine.setEnabled(false)
    clock.emit(2.01)
    engine.setVisibleTracks(['rh'])

    expect(engine.isWaiting).toBe(false)
    expect(onWaitStart).not.toHaveBeenCalled()
  })
})
