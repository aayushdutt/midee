// Reads a `.mid` fixture from the repo-root `fixtures/` dir into an
// ArrayBuffer suitable for `parseMidiFile` (which accepts `File | ArrayBuffer`).
//
// Runs under vitest's jsdom env where Node's `fs` is still available. Paths are
// resolved relative to this file (src/test/) so the helper works regardless of
// the test's cwd. See `fixtures/README.md` for the available files.
//
//   import { loadFixtureMidi } from '../test/loadFixtureMidi'
//   import { parseMidiFile } from '../core/midi/parser'
//   const midi = await parseMidiFile(loadFixtureMidi('multi-track.mid'), 'multi')

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures')

/** Available fixture filenames (see fixtures/README.md). */
export type FixtureName = 'single-track.mid' | 'multi-track.mid' | 'drum-track.mid'

/**
 * Read a fixture `.mid` as an `ArrayBuffer`. The buffer is a fresh slice so it
 * is detached and safe to hand directly to `parseMidiFile`.
 */
export function loadFixtureMidi(name: FixtureName | (string & {})): ArrayBuffer {
  const buf = readFileSync(resolve(FIXTURES_DIR, name))
  // Copy into a fresh ArrayBuffer in the current realm. Node's `Buffer` is a
  // view into a pooled backing store whose `.buffer` is not recognised as the
  // jsdom realm's `ArrayBuffer` (and `parseMidiFile`'s `instanceof ArrayBuffer`
  // check would route it down the `File` path). A clean copy avoids both.
  const out = new ArrayBuffer(buf.byteLength)
  new Uint8Array(out).set(buf)
  return out
}

/** Read a fixture `.mid` as a `Uint8Array`. */
export function loadFixtureMidiBytes(name: FixtureName | (string & {})): Uint8Array {
  return new Uint8Array(loadFixtureMidi(name))
}
