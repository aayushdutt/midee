import type { MasterClock } from '../core/clock/MasterClock'
import type { MidiFile } from '../core/midi/types'
import { jsonPersisted } from '../core/persistence'
import { createEventSignal } from '../store/eventSignal'

export interface KeyLightsSettings {
  outputId: string
  channelMode: 'original' | 'track' | 'single' | 'synthesia'
  channel: number // 1–16 in the UI
}

export interface LightNote {
  pitch: number
  velocity: number
  channel: number // zero-based MIDI channel
  trackIndex: number
}

interface LightEvent extends LightNote {
  time: number
  on: boolean
}

const defaults: KeyLightsSettings = { outputId: '', channelMode: 'original', channel: 1 }
const preferences = jsonPersisted('midee.keyLights', defaults, (raw): KeyLightsSettings => {
  const value = raw as Partial<KeyLightsSettings> | null
  return {
    outputId: typeof value?.outputId === 'string' ? value.outputId : '',
    channelMode:
      value?.channelMode === 'track' ||
      value?.channelMode === 'single' ||
      value?.channelMode === 'synthesia'
        ? value.channelMode
        : 'original',
    channel:
      Number.isInteger(value?.channel) && value!.channel! >= 1 && value!.channel! <= 16
        ? value!.channel!
        : 1,
  }
})

// Only note messages are sent: LED colors are chosen by the device's channel
// palette. Sustain/audio tails do not extend lights past the notated note end.
export class KeyLights {
  readonly settings = createEventSignal(preferences.load())
  readonly outputs = createEventSignal<{ id: string; name: string }[]>([])
  readonly status = createEventSignal<'off' | 'connected' | 'disconnected' | 'error'>('off')
  private access: MIDIAccess | null = null
  private output: MIDIOutput | null = null
  private midi: MidiFile | null = null
  private disabled = new Set<string>()
  private events: LightEvent[] = []
  private handChannels = new Map<number, number>()
  private cursor = 0
  private counts = new Map<number, number>()
  // Includes queued note-ons even if their matching note-off is also queued.
  // clear() cancels both, so explicit note-offs must cover all touched keys.
  private touched = new Set<number>()
  private guidance: readonly LightNote[] | null = null
  private shownGuidance = new Map<number, LightNote>()
  private practiceMode = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly clock: MasterClock) {
    this.unsubscribe = clock.subscribeTransport(() => {
      // Practice owns which chord is shown. Its clock pauses/seeks/resumes
      // internally; those transitions must not reset or replay the LEDs.
      if (!this.practiceMode && this.guidance === null) this.restart()
    })
    window.addEventListener('pagehide', this.onPageHide)
  }

  setAccess(access: MIDIAccess | null): void {
    this.access = access
    this.outputs.set(
      [...(access?.outputs.values() ?? [])]
        .filter((port) => port.state === 'connected')
        .map((port) => ({ id: port.id, name: port.name || port.id })),
    )
    const next = access?.outputs.get(this.settings.value.outputId) ?? null
    const connected = next?.state === 'connected' ? next : null
    if (connected !== this.output) {
      this.stop()
      this.output = connected
      this.updateStatus()
      this.restart()
    } else this.updateStatus()
  }

  configure(patch: Partial<KeyLightsSettings>): void {
    this.stop()
    this.output = null
    this.settings.set({ ...this.settings.value, ...patch })
    preferences.save(this.settings.value)
    this.setAccess(this.access)
  }

  load(midi: MidiFile | null): void {
    if (midi === this.midi && this.guidance === null && !this.practiceMode) return
    this.midi = midi
    this.guidance = null
    this.practiceMode = false
    this.disabled.clear()
    this.rebuild()
  }

  setTrackEnabled(id: string, enabled: boolean): void {
    if (enabled) this.disabled.delete(id)
    else this.disabled.add(id)
    this.rebuild()
  }

  setGuidance(notes: readonly LightNote[] | null): void {
    if (notes === null && this.guidance === null) return
    const enteringGuidance = this.guidance === null
    this.guidance = notes
    if (notes === null) this.restart()
    else {
      if (enteringGuidance) this.stop()
      this.syncGuidance()
    }
  }

  setPracticeMode(enabled: boolean): void {
    if (enabled === this.practiceMode) return
    this.practiceMode = enabled
    this.guidance = null
    this.restart()
  }

  private syncGuidance(): void {
    if (this.disposed || !this.output) return
    const desired = new Map<number, LightNote>()
    for (const note of this.guidance ?? []) {
      const track = this.midi?.tracks[note.trackIndex]
      if (track && this.disabled.has(track.id)) continue
      desired.set(this.channel(note) * 128 + note.pitch, note)
    }
    for (const [key] of this.shownGuidance) {
      if (desired.has(key)) continue
      this.send([0x80 | Math.floor(key / 128), key % 128, 0])
      if (!this.output) return
      this.touched.delete(key)
    }
    for (const [key, note] of desired) {
      if (this.shownGuidance.has(key)) continue
      this.touched.add(key)
      const velocity = Math.max(1, Math.min(127, Math.round(note.velocity * 127)))
      this.send([0x90 | Math.floor(key / 128), note.pitch, velocity])
      if (!this.output) return
    }
    this.shownGuidance = desired
  }

  private rebuild(): void {
    this.events = []
    this.handChannels.clear()
    const pianoTracks = this.midi?.tracks.filter((track) => !track.isDrum && track.notes.length > 0)
    this.midi?.tracks.forEach((track, trackIndex) => {
      if ((pianoTracks?.length ?? 0) > 1 && track.notes.length > 0) {
        const average = track.notes.reduce((sum, note) => sum + note.pitch, 0) / track.notes.length
        // Synthesia's one-based channels 12/13 mean left/right, unknown finger.
        // This is the same track-pitch heuristic used by play-along's hand filter.
        this.handChannels.set(trackIndex, average < 60 ? 11 : 12)
      }
      if (track.isDrum || this.disabled.has(track.id)) return
      for (const note of track.notes) {
        if (note.duration <= 0) continue
        const light = { ...note, channel: track.channel, trackIndex }
        this.events.push({ ...light, time: note.time, on: true })
        this.events.push({ ...light, time: note.time + note.duration, on: false })
      }
    })
    // Release before re-striking the same key at a shared boundary.
    this.events.sort((a, b) => a.time - b.time || Number(a.on) - Number(b.on))
    this.restart()
  }

  private channel(note: LightNote): number {
    const settings = this.settings.value
    if (settings.channelMode === 'single') return settings.channel - 1
    if (settings.channelMode === 'synthesia') {
      return this.handChannels.get(note.trackIndex) ?? (note.pitch < 60 ? 11 : 12)
    }
    if (settings.channelMode === 'track') return note.trackIndex % 16
    return note.channel & 0x0f
  }

  private send(data: number[], timestamp?: number): void {
    if (!this.output) return
    try {
      this.output.send(data, timestamp)
    } catch {
      // Unplug/permission failures must never interrupt playback.
      this.stop()
      this.output = null
      this.status.set('error')
    }
  }

  private emit(event: LightNote, on: boolean, timestamp?: number): void {
    const channel = this.channel(event)
    const key = channel * 128 + event.pitch
    const count = this.counts.get(key) ?? 0
    if (on) {
      this.counts.set(key, count + 1)
      this.touched.add(key)
      if (count === 0) {
        const velocity = Math.max(1, Math.min(127, Math.round(event.velocity * 127)))
        this.send([0x90 | channel, event.pitch, velocity], timestamp)
      }
    } else if (count > 0) {
      if (count === 1) {
        this.counts.delete(key)
        this.send([0x80 | channel, event.pitch, 0], timestamp)
      } else this.counts.set(key, count - 1)
    }
  }

  private restart(): void {
    this.stop()
    if (this.disposed || !this.output) return
    if (this.guidance) {
      this.syncGuidance()
      return
    }
    if (this.practiceMode || !this.clock.playing || !this.midi) return
    const time = this.clock.currentTime
    const held = new Map<number, LightNote>()
    // Reconstruct notes held at the new position, including a seek mid-note.
    this.cursor = 0
    while (this.cursor < this.events.length && this.events[this.cursor]!.time <= time) {
      const event = this.events[this.cursor++]!
      const key = this.channel(event) * 128 + event.pitch
      const count = this.counts.get(key) ?? 0
      if (event.on) {
        this.counts.set(key, count + 1)
        held.set(key, event)
      } else if (count <= 1) this.counts.delete(key)
      else this.counts.set(key, count - 1)
    }
    for (const [key] of this.counts) {
      this.touched.add(key)
      const velocity = Math.max(1, Math.min(127, Math.round(held.get(key)!.velocity * 127)))
      this.send([0x90 | Math.floor(key / 128), key % 128, velocity])
      if (!this.output) return
    }
    this.timer = setInterval(() => this.schedule(), 25)
    this.schedule()
  }

  private schedule(): void {
    if (!this.output || !this.clock.playing) return
    const time = this.clock.currentTime
    const now = performance.now()
    const speed = this.clock.speed
    const horizon = time + 0.1 * speed
    while (this.cursor < this.events.length && this.events[this.cursor]!.time <= horizon) {
      const event = this.events[this.cursor++]!
      this.emit(event, event.on, now + Math.max(0, ((event.time - time) / speed) * 1000))
      if (!this.output) break
    }
  }

  private stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.output) {
      try {
        this.output.clear()
        for (const key of this.touched) {
          this.output.send([0x80 | Math.floor(key / 128), key % 128, 0])
        }
      } catch {
        // Disconnected devices can no longer receive cleanup messages.
      }
    }
    this.counts.clear()
    this.touched.clear()
    this.shownGuidance.clear()
  }

  private updateStatus(): void {
    this.status.set(
      !this.settings.value.outputId ? 'off' : this.output ? 'connected' : 'disconnected',
    )
  }

  private onPageHide = (): void => this.stop()

  dispose(): void {
    this.disposed = true
    this.stop()
    this.unsubscribe()
    window.removeEventListener('pagehide', this.onPageHide)
  }
}
