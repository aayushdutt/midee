import { createSignal, onCleanup } from 'solid-js'

export function FpsOverlay() {
  const [fps, setFps] = createSignal(0)

  let frames = 0
  let lastTime = performance.now()
  let rafId = 0

  const loop = (now: number) => {
    frames++
    const elapsed = now - lastTime
    if (elapsed >= 500) {
      setFps(Math.round((frames * 1000) / elapsed))
      frames = 0
      lastTime = now
    }
    rafId = requestAnimationFrame(loop)
  }
  rafId = requestAnimationFrame(loop)
  onCleanup(() => cancelAnimationFrame(rafId))

  return (
    <div
      style={{
        position: 'fixed',
        top: '8px',
        right: '8px',
        'z-index': '9999',
        background: 'rgba(0,0,0,0.75)',
        color: '#4ade80',
        'font-family': 'monospace',
        'font-size': '13px',
        padding: '3px 8px',
        'border-radius': '4px',
        'pointer-events': 'none',
        'user-select': 'none',
      }}
    >
      {fps()} fps
    </div>
  )
}
