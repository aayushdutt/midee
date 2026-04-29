import type { JSX } from 'solid-js'
import { render } from 'solid-js/web'

/**
 * Creates a { mount, unmount } handle that renders a Solid component into a
 * host HTMLElement. Replaces the pre-Solid-migration pattern of wrapping
 * every UI component in an ad-hoc imperative class with manual div creation,
 * render(), and dispose tracking.
 *
 * `setup` runs on the wrapper div before mounting — use it for positioning
 * styles, class names, etc. — and ensures no accidental style leakage between
 * call sites.
 */
export function createMountHandle<P>(
  component: (props: P) => JSX.Element,
  setup?: (div: HTMLDivElement) => void,
) {
  let dispose: (() => void) | null = null
  let wrapper: HTMLDivElement | null = null

  return {
    mount(host: HTMLElement, props: P): void {
      wrapper?.remove()
      const div = document.createElement('div')
      setup?.(div)
      host.appendChild(div)
      wrapper = div
      dispose = render(() => component(props), div)
    },
    unmount(): void {
      dispose?.()
      wrapper?.remove()
      dispose = null
      wrapper = null
    },
  }
}
