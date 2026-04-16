# Nocturne

A luminous, zero-install piano-roll player for the browser. Drop in a MIDI file and watch notes cascade past a full 88-key keyboard — or plug in a MIDI controller (or just your laptop keyboard) and play live with particle trails, glow, and a handful of hand-tuned themes.

Built as a single-page app on WebGL (PixiJS) with a clock-driven renderer, Web Audio synthesis via Tone.js, and an offline MP4 exporter powered by FFmpeg.wasm.

> Working name — easy to rename. Other candidates in consideration: **Lumen**, **Aurora**, **Ivory**, **Glissando**.

---

## Features

- **Drag-and-drop MIDI playback** — standard `.mid` / `.midi` files, multi-track, with per-track color.
- **Live mode** — play the visualiser in real time via Web MIDI devices or the QWERTY keyboard (FL Studio layout, octave shift).
- **On-screen keyboard** — click or touch any key; pressed keys light up in the active theme color.
- **Particle bursts & glow** — notes emit particles on impact and trail a soft bloom as they scroll.
- **Five curated themes** — `Dark`, `Midnight`, `Neon`, `Sunset`, `Ocean`. Cycle with one keypress.
- **Resizable keyboard** — drag the split between the roll and the keyboard; preference is persisted.
- **Offline video export** — render the current MIDI to an MP4 at 30 / 60 fps, frame-accurate, entirely in the browser.
- **Track panel** — solo, mute, rename, and recolor individual tracks.
- **Zero backend** — static site; everything runs client-side.

---

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build:

```bash
npm run build
npm run preview
```

The build emits a fully static bundle in `dist/` — drop it on any CDN or static host.

### Requirements

- Node.js 18+
- A browser with [Web MIDI](https://caniuse.com/midi) (for hardware keyboards) and [WebCodecs](https://caniuse.com/webcodecs) (for MP4 export). Chrome 94+, Safari 16.4+, and Firefox 130+ all qualify.

---

## How to use

| Mode | How you get there | What happens |
| --- | --- | --- |
| **Home** | Opening the app | A gentle idle state with the drop zone visible. Tap a key and you slide straight into live mode. |
| **File** | Drop a `.mid` onto the window, or click *Open file* | Transport controls, scrubbing, track panel, and video export become available. |
| **Live** | Click *Live*, press a computer key, or connect a MIDI device | Notes are generated in real time, rendered above the keyboard, and synthesised instantly. |

### Keyboard shortcuts

| Key(s) | Action |
| --- | --- |
| `Space` | Play / pause |
| `Z`..`M` / `Q`..`P` | Play notes (two overlapping octaves) |
| `S D G H J` / `2 3 5 6 7` | Black keys |
| `←` / `→` | Octave down / up (live mode) |
| *Theme button* | Cycle through the five themes |

---

## Themes

Each theme tunes the background, glow strength, key colors, now-line, and per-track palette. All lighting is driven by the single `Theme` descriptor in `src/renderer/theme.ts`, so adding a sixth is a ~20-line change.

---

## Exporting a video

1. Load a MIDI file.
2. Click *Record* → choose a frame rate.
3. The renderer is driven deterministically frame-by-frame while FFmpeg.wasm stitches an MP4 in the background.
4. A `pianoroll.mp4` is offered as a download when done.

Export runs entirely in-browser — nothing leaves your machine.

---

## Architecture

```
src/
├── app.ts                  # Top-level App: wires everything together
├── main.ts                 # Entry point
├── core/
│   ├── clock/MasterClock   # Single source of truth for time (play / pause / seek / speed)
│   └── midi/               # MIDI file parser and internal types
├── audio/
│   ├── AudioEngine         # WebAudio context + master bus
│   └── SynthEngine         # Tone.js piano sampler, file + live voices
├── midi/
│   ├── MidiInputManager    # Web MIDI device discovery + event stream
│   ├── ComputerKeyboardInput
│   └── LiveNoteStore       # Currently-held notes for the renderer
├── renderer/               # PixiJS scene graph
│   ├── PianoRollRenderer   # Orchestrates the full frame
│   ├── NoteRenderer        # Falling notes from loaded MIDI
│   ├── LiveNoteRenderer    # Growing bars while keys are held
│   ├── KeyboardRenderer    # 88-key piano at the bottom
│   ├── BeatGrid            # Bar / beat guide lines
│   ├── ParticleSystem      # Burst particles on note-on
│   └── theme.ts / viewport.ts
├── export/VideoExporter    # Deterministic frame pump → FFmpeg.wasm → MP4
├── store/state.ts          # Tiny Signal-based reactive store (no framework)
├── ui/                     # Vanilla-TS UI widgets (Controls, TrackPanel, ExportModal, …)
└── styles/                 # Global CSS
```

Key design choices:

- **One clock, many consumers.** `MasterClock` ticks once per frame; the renderer, synth, and UI all read from it. Seeking is instant because nothing caches time.
- **No UI framework.** A ~50-line `Signal<T>` pub/sub in `store/state.ts` is enough for this surface area and keeps the bundle tiny.
- **Renderer owns the canvas.** All drawing is in PixiJS; DOM overlays (controls, modals, toasts) live in a separate layered `#ui-overlay`.
- **Live and file paths are symmetric.** The renderer and synth accept both recorded note-events and live MIDI events through the same API.

---

## Tech stack

- **[Vite](https://vitejs.dev/)** + **TypeScript** (strict)
- **[PixiJS 8](https://pixijs.com/)** for WebGL rendering, plus `pixi-filters` for glow/bloom
- **[Tone.js](https://tonejs.github.io/)** + `@tonejs/piano` for sampled piano synthesis
- **[@tonejs/midi](https://github.com/Tonejs/Midi)** for MIDI parsing
- **[@ffmpeg/ffmpeg](https://ffmpegwasm.netlify.app/)** for in-browser MP4 encoding

---

## Scripts

| Script | |
| --- | --- |
| `npm run dev` | Start Vite in dev mode with HMR |
| `npm run build` | Type-check + produce a static production bundle |
| `npm run preview` | Serve the production build locally |

---

## Roadmap

- [ ] Save / restore sessions (file + view state)
- [ ] Per-track solo/mute hotkeys
- [ ] Configurable particle density for low-power devices
- [ ] Sustain pedal (CC 64) support in live mode
- [ ] Audio-only export (WAV / OGG)

---

## License

MIT © contributors.
