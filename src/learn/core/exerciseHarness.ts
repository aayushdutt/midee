/** Minimal lifecycle harness for exercises. Owns HUD mount/unmount and
 *  keyboard-listener add/remove so exercises don't copy-paste the same
 *  ceremony into every `mount`/`unmount`/`start`/`stop` block.
 *
 *  The harness guards against double-attach (idempotent `attachKeys`) so
 *  that a rapid restart cycle doesn't leak a duplicate listener into the
 *  hub or other modes. */

export interface Huddable {
  mount(host: HTMLElement, opts: unknown): void
  unmount(): void
}

export interface ExerciseHarness {
  /** Mount the HUD into the host element. Call from `Exercise.mount()`. */
  mountHud(host: HTMLElement): void
  /** Unmount the HUD. Call from `Exercise.unmount()`. */
  unmountHud(): void
  /** Register the keyboard listener (idempotent). Call from `Exercise.start()`. */
  attachKeys(): void
  /** Remove the keyboard listener (idempotent). Call from `Exercise.stop()`. */
  detachKeys(): void
}

export function createExerciseHarness(opts: {
  hud: Huddable
  hudOpts: unknown
  onKeyDown?: (e: KeyboardEvent) => void
}): ExerciseHarness {
  let keysAttached = false

  return {
    mountHud(host: HTMLElement): void {
      opts.hud.mount(host, opts.hudOpts)
    },
    unmountHud(): void {
      opts.hud.unmount()
    },
    attachKeys(): void {
      if (keysAttached || !opts.onKeyDown) return
      window.addEventListener('keydown', opts.onKeyDown)
      keysAttached = true
    },
    detachKeys(): void {
      if (!keysAttached || !opts.onKeyDown) return
      window.removeEventListener('keydown', opts.onKeyDown)
      keysAttached = false
    },
  }
}
