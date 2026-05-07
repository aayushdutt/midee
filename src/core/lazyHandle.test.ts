import { describe, expect, it, vi } from 'vitest'
import { lazyHandle } from './lazyHandle'

describe('lazyHandle', () => {
  it('returns the loaded value through get()', async () => {
    const h = lazyHandle(() => Promise.resolve(42))
    await expect(h.get()).resolves.toBe(42)
  })

  it('peek() returns null before first get()', () => {
    const h = lazyHandle(() => Promise.resolve(42))
    expect(h.peek()).toBeNull()
  })

  it('peek() returns the value after get() resolves', async () => {
    const h = lazyHandle(() => Promise.resolve(42))
    await h.get()
    expect(h.peek()).toBe(42)
  })

  it('calls the loader at most once', async () => {
    const loader = vi.fn(() => Promise.resolve('x'))
    const h = lazyHandle(loader)
    await Promise.all([h.get(), h.get(), h.get()])
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('concurrent get() calls return the same promise', async () => {
    let resolve: (v: string) => void
    const deferred = new Promise<string>((r) => {
      resolve = r
    })
    const loader = vi.fn(() => deferred)
    const h = lazyHandle(loader)

    const p1 = h.get()
    const p2 = h.get()
    expect(loader).toHaveBeenCalledTimes(1)

    resolve!('done')
    const [v1, v2] = await Promise.all([p1, p2])
    expect(v1).toBe('done')
    expect(v2).toBe('done')
  })

  it('subsequent get() after resolve returns the cached value without calling loader again', async () => {
    const loader = vi.fn(() => Promise.resolve('x'))
    const h = lazyHandle(loader)

    await h.get()
    await h.get()

    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('rejects if the loader rejects, and the rejection is not cached (retries on next get())', async () => {
    let calls = 0
    const h = lazyHandle(() => {
      calls++
      if (calls === 1) return Promise.reject(new Error('fail'))
      return Promise.resolve('ok')
    })

    await expect(h.get()).rejects.toThrow('fail')
    expect(h.peek()).toBeNull()

    await expect(h.get()).resolves.toBe('ok')
    expect(h.peek()).toBe('ok')
  })
})
