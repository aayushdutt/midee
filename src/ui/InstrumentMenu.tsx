import { createSignal, For } from 'solid-js'
import { render } from 'solid-js/web'
import { INSTRUMENTS, type InstrumentId } from '../audio/SynthEngine'
import { icons } from './icons'
import { isNarrowViewport } from './utils'

// Topbar instrument picker — a pill trigger + dropdown menu. Available in
// both live and file modes so users can hear any loaded MIDI played back with
// a different voice (not just live input).

interface TriggerProps {
  label: () => string
  loading: () => boolean
  isOpen: () => boolean
  onToggle: () => void
  registerEl: (el: HTMLButtonElement) => void
}

function TriggerView(props: TriggerProps) {
  return (
    <button
      ref={(el) => props.registerEl(el)}
      class="ts-pill ts-pill--instrument"
      classList={{
        'ts-pill--open': props.isOpen(),
        'ts-pill--loading': props.loading(),
      }}
      id="ts-instrument"
      type="button"
      title="Instrument"
      aria-label="Choose instrument"
      aria-busy={props.loading() ? 'true' : 'false'}
      onClick={() => props.onToggle()}
    >
      <span class="ts-instrument-icon-slot">
        <span innerHTML={icons.instrument()} />
        <span class="ts-instrument-spinner" aria-hidden="true"></span>
      </span>
      <span class="ts-instrument-label" id="ts-instrument-label">
        {props.label()}
      </span>
      <span innerHTML={icons.chevronDown(10)} />
    </button>
  )
}

interface MenuProps {
  current: () => InstrumentId
  loading: () => InstrumentId | null
  isOpen: () => boolean
  isSheet: () => boolean
  onSelect: (id: InstrumentId) => void
  registerEl: (el: HTMLElement) => void
}

function MenuView(props: MenuProps) {
  return (
    <div
      ref={(el) => props.registerEl(el)}
      class="ts-popover ts-instrument-menu"
      classList={{
        'ts-popover--open': props.isOpen(),
        'popover--sheet': props.isSheet(),
      }}
    >
      <div class="panel-header">
        <span class="panel-label">Instrument</span>
      </div>
      <div class="instrument-items">
        <For each={INSTRUMENTS}>
          {(inst) => (
            <button
              class="instrument-item"
              classList={{
                'instrument-item--on': props.current() === inst.id,
                'instrument-item--loading': props.loading() === inst.id,
              }}
              data-id={inst.id}
              type="button"
              onClick={() => props.onSelect(inst.id)}
            >
              <span class="instrument-item-dot" aria-hidden="true"></span>
              <span class="instrument-item-body">
                <span class="instrument-item-name">{inst.name}</span>
                <span class="instrument-item-sub">{inst.description}</span>
              </span>
              <span class="instrument-item-check" aria-hidden="true" innerHTML={icons.check()} />
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

export class InstrumentMenu {
  readonly trigger!: HTMLButtonElement
  private menu!: HTMLElement
  private isOpen = false
  private disposeTrigger: (() => void) | null = null
  private disposeMenu: (() => void) | null = null
  private menuWrapper: HTMLDivElement | null = null
  private triggerWrapper: HTMLDivElement | null = null

  private readonly writeCurrent: (v: InstrumentId) => void
  private readonly readCurrent: () => InstrumentId
  private readonly writeLoading: (v: InstrumentId | null) => void
  private readonly setIsOpen: (v: boolean) => void
  private readonly setIsSheet: (v: boolean) => void

  onSelect?: (id: InstrumentId) => void

  private onDocPointer = (e: PointerEvent): void => {
    const target = e.target as Node
    if (this.menu.contains(target)) return
    if (this.trigger.contains(target)) return
    this.close()
  }
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.isOpen) this.close()
  }
  private onResize = (): void => {
    if (!this.isOpen) return
    if (this.menu.classList.contains('popover--sheet') || isNarrowViewport()) {
      this.close()
      return
    }
    this.positionUnder()
  }

  constructor(triggerHost: HTMLElement, popoverHost: HTMLElement) {
    const [current, setCurrent] = createSignal<InstrumentId>('piano')
    const [loading, setLoading] = createSignal<InstrumentId | null>(null)
    const [isOpen, setIsOpen] = createSignal(false)
    const [isSheet, setIsSheet] = createSignal(false)

    this.readCurrent = current
    this.writeCurrent = setCurrent
    this.writeLoading = setLoading
    this.setIsOpen = setIsOpen
    this.setIsSheet = setIsSheet

    const label = (): string => {
      const info = INSTRUMENTS.find((i) => i.id === current())
      return info?.name ?? 'Piano'
    }

    const triggerWrapper = document.createElement('div')
    triggerWrapper.style.display = 'contents'
    triggerHost.appendChild(triggerWrapper)
    this.triggerWrapper = triggerWrapper
    let triggerEl!: HTMLButtonElement
    this.disposeTrigger = render(
      () => (
        <TriggerView
          label={label}
          loading={() => loading() !== null}
          isOpen={isOpen}
          onToggle={() => this.toggle()}
          registerEl={(el) => {
            triggerEl = el
          }}
        />
      ),
      triggerWrapper,
    )
    ;(this as { trigger: HTMLButtonElement }).trigger = triggerEl

    const menuWrapper = document.createElement('div')
    popoverHost.appendChild(menuWrapper)
    this.menuWrapper = menuWrapper
    this.disposeMenu = render(
      () => (
        <MenuView
          current={current}
          loading={loading}
          isOpen={isOpen}
          isSheet={isSheet}
          onSelect={(id) => {
            this.writeCurrent(id)
            this.close()
            this.onSelect?.(id)
          }}
          registerEl={(el) => {
            this.menu = el
          }}
        />
      ),
      menuWrapper,
    )
  }

  setCurrent(id: InstrumentId): void {
    this.writeCurrent(id)
  }

  // Drives the loading indicator on both the trigger pill and the matching
  // dropdown row. Pass the id being loaded, or null when nothing is loading.
  setLoading(id: InstrumentId | null): void {
    this.writeLoading(id)
  }

  getCurrent(): InstrumentId {
    return this.readCurrent()
  }

  private toggle(): void {
    this.isOpen ? this.close() : this.open()
  }

  private open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.setIsOpen(true)
    if (isNarrowViewport()) {
      this.setIsSheet(true)
      this.menu.style.top = ''
      this.menu.style.right = ''
      this.menu.style.left = ''
    } else {
      this.setIsSheet(false)
      this.positionUnder()
    }
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onDocPointer)
      document.addEventListener('keydown', this.onKey)
      window.addEventListener('resize', this.onResize)
    }, 0)
  }

  private close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.setIsOpen(false)
    this.setIsSheet(false)
    document.removeEventListener('pointerdown', this.onDocPointer)
    document.removeEventListener('keydown', this.onKey)
    window.removeEventListener('resize', this.onResize)
  }

  private positionUnder(): void {
    const rect = this.trigger.getBoundingClientRect()
    const menuW = this.menu.offsetWidth || 260
    const right = Math.max(12, window.innerWidth - rect.right)
    const top = rect.bottom + 8
    this.menu.style.right = `${right}px`
    this.menu.style.top = `${top}px`
    this.menu.style.left = ''
    const desiredLeft = window.innerWidth - right - menuW
    if (desiredLeft < 12)
      this.menu.style.right = `${Math.max(12, window.innerWidth - menuW - 12)}px`
  }

  dispose(): void {
    this.close()
    this.disposeTrigger?.()
    this.disposeMenu?.()
    this.disposeTrigger = null
    this.disposeMenu = null
    this.triggerWrapper?.remove()
    this.menuWrapper?.remove()
    this.triggerWrapper = null
    this.menuWrapper = null
  }
}
