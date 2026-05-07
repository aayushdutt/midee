import type { LiveLooper } from './LiveLooper'
import type { SessionRecorder } from './SessionRecorder'

/** Thin fan-out layer that routes capture events to both the looper and
 *  session recorder in a single call. Eliminates the duplicated
 *  `.captureNoteOn/Off` call pairs scattered across app.ts and keeps the
 *  capture surface in one place — if a third capture target (e.g. replay
 *  buffer) is added, only this module changes. */
export class CaptureFanout {
  constructor(
    private looper: LiveLooper,
    private sessionRec: SessionRecorder,
  ) {}

  captureNoteOn(pitch: number, velocity: number, clockTime: number): void {
    this.looper.captureNoteOn(pitch, velocity, clockTime)
    this.sessionRec.captureNoteOn(pitch, velocity, clockTime)
  }

  captureNoteOff(pitch: number, clockTime: number): void {
    this.looper.captureNoteOff(pitch, clockTime)
    this.sessionRec.captureNoteOff(pitch, clockTime)
  }
}
