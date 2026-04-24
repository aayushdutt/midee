import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { render } from 'solid-js/web'
import { t } from '../i18n'
import type { MidiDeviceStatus } from '../midi/MidiInputManager'
import { icons } from './icons'
import { SamplesGrid } from './SamplesGrid'

export type LoadSource = 'drag' | 'picker'
type DropHandler = (file: File, source: LoadSource) => void
type SampleHandler = (sampleId: string) => void

function isMidiFile(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.endsWith('.mid') || lower.endsWith('.midi')
}

function getHomeMidiStatus(status: MidiDeviceStatus, deviceName: string): string {
  if (status === 'connected') return deviceName || t('home.midi.ready')
  if (status === 'blocked') return t('home.midi.blocked')
  if (status === 'unavailable') return t('home.midi.unavailable')
  return t('home.midi.disconnected')
}

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

interface DropZoneProps {
  onDrop: DropHandler
  onLiveMode?: (() => void) | undefined
  onSample?: SampleHandler | undefined
  hidden: () => boolean
  midiStatus: () => { status: MidiDeviceStatus; deviceName: string }
  triggerFilePicker: (fn: () => void) => void
}

function DropZoneView(props: DropZoneProps) {
  let el!: HTMLDivElement
  let inputEl!: HTMLInputElement
  let samplesHost!: HTMLDivElement

  const [dragOver, setDragOver] = createSignal(false)
  const [coarse, setCoarse] = createSignal(
    typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(pointer: coarse)').matches
      : false,
  )
  let dragDepth = 0

  // Document-level drag listeners so any drop on the page (not just over the
  // dropzone) is interpreted as a file open. Using a per-window depth counter
  // handles dragenter/leave firing on child elements.
  const docDragEnter = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    dragDepth++
    setDragOver(true)
  }
  const docDragLeave = (e: DragEvent): void => {
    if (!hasFiles(e)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) setDragOver(false)
  }
  const docDragOver = (e: DragEvent): void => {
    e.preventDefault()
  }
  const docDrop = (e: DragEvent): void => {
    e.preventDefault()
    dragDepth = 0
    setDragOver(false)
    const file = e.dataTransfer?.files[0]
    if (file && isMidiFile(file.name)) props.onDrop(file, 'drag')
  }

  onMount(() => {
    document.addEventListener('dragenter', docDragEnter)
    document.addEventListener('dragleave', docDragLeave)
    document.addEventListener('dragover', docDragOver)
    document.addEventListener('drop', docDrop)

    // Mirror coarse-pointer state so CSS can swap to a touch-optimised
    // layout on the dropzone root.
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(pointer: coarse)')
      const onChange = (ev: MediaQueryListEvent): void => {
        setCoarse(ev.matches)
      }
      mq.addEventListener('change', onChange)
      onCleanup(() => mq.removeEventListener('change', onChange))
    }

    // Legacy SamplesGrid class — mounts its own DOM. Replaced when T19
    // ports it to a Solid component.
    const samples = new SamplesGrid()
    samples.onSelect = (id) => props.onSample?.(id)
    samplesHost.appendChild(samples.root)

    // Expose openFilePicker up to the imperative class shell.
    props.triggerFilePicker(() => inputEl.click())
  })

  onCleanup(() => {
    document.removeEventListener('dragenter', docDragEnter)
    document.removeEventListener('dragleave', docDragLeave)
    document.removeEventListener('dragover', docDragOver)
    document.removeEventListener('drop', docDrop)
  })

  return (
    <div
      id="dropzone"
      ref={el}
      classList={{
        'dz--hidden': props.hidden(),
        'drag-over': dragOver(),
        'dropzone--touch': coarse(),
      }}
    >
      <div class="home-card">
        <span class="home-kicker">{t('home.kicker')}</span>
        {/* biome-ignore lint/a11y/useHeadingContent: `home.title.html` is
            a translation key whose value is raw HTML (for per-locale inline
            markup); biome can't introspect innerHTML. Content is always
            present at runtime. */}
        <h1 class="home-title" innerHTML={t('home.title.html')} />
        <p class="home-sub">{t('home.subtitle')}</p>

        <div class="home-actions">
          <button
            class="home-primary-btn"
            id="home-open"
            type="button"
            onClick={() => inputEl.click()}
          >
            <span innerHTML={icons.upload(13)} />
            <span>{t('home.cta.openMidi')}</span>
          </button>
          <Show when={props.onLiveMode}>
            {(cb) => (
              <button
                class="home-secondary-btn"
                id="home-live"
                type="button"
                onClick={() => cb()()}
              >
                <span innerHTML={icons.midi(13)} />
                <span>{t('home.cta.playLive')}</span>
              </button>
            )}
          </Show>
        </div>

        <div class="home-samples">
          <div class="home-samples-label">{t('home.samples.label')}</div>
          <div class="home-samples-mount" ref={samplesHost} />
        </div>

        <div class="home-footnotes">
          <div
            class="home-midi-status"
            id="home-midi-status"
            data-midi-status={props.midiStatus().status}
          >
            {getHomeMidiStatus(props.midiStatus().status, props.midiStatus().deviceName)}
          </div>
          <div class="home-drop-hint" innerHTML={t('home.dropHint.html')} />
        </div>
        <nav class="home-meta-links" aria-label="midee links">
          <a
            href="/blog/"
            class="home-meta-link"
            aria-label={t('home.metaLink.blog')}
            data-tip={t('home.metaLink.blog')}
            innerHTML={icons.blog()}
          />
          <a
            href="https://github.com/aayushdutt/midee"
            class="home-meta-link"
            aria-label={t('home.metaLink.github')}
            data-tip={t('home.metaLink.github')}
            target="_blank"
            rel="noopener noreferrer"
            innerHTML={icons.github()}
          />
          <a
            href="https://discord.gg/7As2NHHd"
            class="home-meta-link"
            aria-label={t('home.metaLink.discord')}
            data-tip={t('home.metaLink.discord')}
            target="_blank"
            rel="noopener noreferrer"
            innerHTML={icons.discord()}
          />
        </nav>
        <input
          type="file"
          id="midi-input"
          ref={inputEl}
          accept=".mid,.midi"
          style={{ display: 'none' }}
          onChange={() => {
            const file = inputEl.files?.[0]
            if (file && isMidiFile(file.name)) props.onDrop(file, 'picker')
            inputEl.value = ''
          }}
        />
      </div>
    </div>
  )
}

export class DropZone {
  private disposeRoot: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null
  private hiddenSetter!: (v: boolean) => void
  private statusSetter!: (v: { status: MidiDeviceStatus; deviceName: string }) => void
  private filePicker: (() => void) | null = null

  constructor(
    container: HTMLElement,
    onDrop: DropHandler,
    onLiveMode?: () => void,
    onSample?: SampleHandler,
  ) {
    const [hidden, setHidden] = createSignal(false)
    const [status, setStatus] = createSignal<{
      status: MidiDeviceStatus
      deviceName: string
    }>({ status: 'disconnected', deviceName: '' })
    this.hiddenSetter = setHidden
    this.statusSetter = setStatus

    const wrapper = document.createElement('div')
    container.appendChild(wrapper)
    this.wrapper = wrapper
    this.disposeRoot = render(
      () => (
        <DropZoneView
          onDrop={onDrop}
          onLiveMode={onLiveMode}
          onSample={onSample}
          hidden={hidden}
          midiStatus={status}
          triggerFilePicker={(fn) => {
            this.filePicker = fn
          }}
        />
      ),
      wrapper,
    )
  }

  updateMidiStatus(status: MidiDeviceStatus, deviceName: string): void {
    this.statusSetter({ status, deviceName })
  }

  openFilePicker(): void {
    this.filePicker?.()
  }

  show(): void {
    this.hiddenSetter(false)
  }

  hide(): void {
    this.hiddenSetter(true)
  }

  dispose(): void {
    this.disposeRoot?.()
    this.disposeRoot = null
    this.wrapper?.remove()
    this.wrapper = null
  }
}
