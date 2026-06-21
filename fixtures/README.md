# Test fixtures

Small, real `.mid` files for the test suite. Load them with
`src/test/loadFixtureMidi.ts`:

```ts
import { loadFixtureMidi } from '../test/loadFixtureMidi'
import { parseMidiFile } from '../core/midi/parser'

const midi = await parseMidiFile(loadFixtureMidi('multi-track.mid'), 'multi')
```

These were generated programmatically with `@tonejs/midi` (kept tiny — a few
bars each — rather than trimming large repertoire MIDIs) so the parsed shape is
fully known and deterministic.

| File              | Tracks                            | Contents                                                                                 |
| ----------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `single-track.mid`| 1 (ch 0, "Piano")                 | 120 BPM. C-major scale (C4→C5, 8 notes @ 0.5s) then a C-major triad (60/64/67) at t=4.   |
| `multi-track.mid` | 2 (ch 0 "Right Hand", ch 1 "Left Hand") | 100 BPM. RH melody C5→F5; LH bass alternating C3/G2. Exercises multi-track parsing.  |
| `drum-track.mid`  | 2 (ch 0 "Lead", ch 9 "Drums")     | 120 BPM. A melodic lead track plus a channel-9 drum groove (kick 36 / snare 38 / hat 42) → parser flags the drum track `isDrum: true`. |

To regenerate, build with `@tonejs/midi`'s writer (`midi.addTrack()` /
`track.addNote(...)` / `midi.toArray()`). Channel 9 marks a track as drums in
`src/core/midi/parser.ts`.
