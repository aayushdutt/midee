import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { KEYBOARD_HEIGHT_MAX, KEYBOARD_HEIGHT_MIN } from '../renderer/PianoRollRenderer'

const STORAGE_KEY = 'midee.keyboardHeight'

function viewportBounds(): { min: number; max: number } {
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900
  const min = Math.max(KEYBOARD_HEIGHT_MIN, Math.round(vh * 0.18))
  const max = Math.min(KEYBOARD_HEIGHT_MAX, Math.round(vh * 0.6))
  if (min >= max) return { min: KEYBOARD_HEIGHT_MIN, max: KEYBOARD_HEIGHT_MAX }
  return { min, max }
}

function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(pointer: coarse)').matches
}

interface ResizerProps {
  getHeight: () => number
  setHeight: (px: number) => void
}

function KeyboardResizerView(props: ResizerProps) {
  let el!: HTMLDivElement
  const [active, setActive] = createSignal(false)

  // Touch devices use a fixed CSS-driven keyboard; skip pointer handlers so a
  // stray tap on the seam can't move it. Desktop flow is unchanged.
  const coarse = isCoarsePointer()

  function onPointerDown(e: PointerEvent): void {
    if (coarse) return
    e.preventDefault()
    setActive(true)
    const startY = e.clientY
    const startHeight = props.getHeight()
    el.setPointerCapture(e.pointerId)

    const onMove = (ev: PointerEvent): void => {
      // Dragging up increases keyboard height (intuitive pull-up gesture).
      props.setHeight(startHeight + (startY - ev.clientY))
    }
    const onUp = (ev: PointerEvent): void => {
      setActive(false)
      el.releasePointerCapture(ev.pointerId)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      localStorage.setItem(STORAGE_KEY, String(props.getHeight()))
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  function onDoubleClick(): void {
    if (coarse) return
    const { min, max } = viewportBounds()
    props.setHeight(Math.min(max, Math.max(min, 120)))
    localStorage.removeItem(STORAGE_KEY)
  }

  return (
    // Decorative mouse-only drag handle. A11y omitted deliberately — screen
    // readers + keyboard users resize via a larger control in Customize; a
    // focusable separator here would add a confusing tab stop with nothing
    // actionable behind it.
    <div
      id="kbd-resizer"
      ref={el}
      classList={{ 'kbd-resizer--active': active() }}
      aria-hidden="true"
      {...(coarse ? {} : { onPointerDown, onDblClick: onDoubleClick })}
    >
      <span class="kbd-resizer-grip" />
    </div>
  )
}

export class KeyboardResizer {
  private disposeRoot: (() => void) | null = null
  private wrapper: HTMLDivElement | null = null

  constructor(
    container: HTMLElement,
    private getHeight: () => number,
    private setHeight: (px: number) => void,
  ) {
    this.wrapper = document.createElement('div')
    container.appendChild(this.wrapper)
    this.disposeRoot = render(
      () => <KeyboardResizerView getHeight={this.getHeight} setHeight={this.setHeight} />,
      this.wrapper,
    )
  }

  restoreSaved(): void {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const { min, max } = viewportBounds()
    this.setHeight(Math.min(max, Math.max(min, value)))
  }

  dispose(): void {
    this.disposeRoot?.()
    this.disposeRoot = null
    this.wrapper?.remove()
    this.wrapper = null
  }
}
