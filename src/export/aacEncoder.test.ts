import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stand-ins for Mediabunny's capability probe and the WASM extension. `native`
// is what the browser's own AudioEncoder answers; once the extension is
// registered, Mediabunny answers true through it regardless.
const env = { native: true, registered: false }
const registerAacEncoder = vi.fn(() => {
  env.registered = true
})

vi.mock('mediabunny', () => ({
  Quality: class {},
  canEncodeAudio: vi.fn(async () => env.native || env.registered),
}))

const CONFIG = { sampleRate: 44_100, numberOfChannels: 2, bitrate: 192_000 }

// Fresh module per test: registration state is module-global by design.
async function load(): Promise<typeof import('./aacEncoder')> {
  vi.resetModules()
  return import('./aacEncoder')
}

describe('resolveAacEncoder', () => {
  beforeEach(() => {
    Object.assign(env, { native: true, registered: false })
    registerAacEncoder.mockClear()
    // doMock (not hoisted vi.mock) so a test can swap in a failing chunk;
    // factories survive resetModules, so each test sets its own.
    vi.doMock('@mediabunny/aac-encoder', () => ({ registerAacEncoder }))
  })

  it('uses the native encoder and never loads WASM when the browser has AAC', async () => {
    const { resolveAacEncoder } = await load()
    expect(await resolveAacEncoder(CONFIG)).toBe('native')
    expect(registerAacEncoder).not.toHaveBeenCalled()
  })

  it('registers the WASM encoder when the browser has no AAC (Safari ≤ 18)', async () => {
    env.native = false
    const { resolveAacEncoder } = await load()
    expect(await resolveAacEncoder(CONFIG)).toBe('wasm')
    expect(registerAacEncoder).toHaveBeenCalledOnce()
  })

  it('keeps reporting wasm on later exports instead of re-registering', async () => {
    env.native = false
    const { resolveAacEncoder } = await load()
    await resolveAacEncoder(CONFIG)
    expect(await resolveAacEncoder(CONFIG)).toBe('wasm')
    expect(registerAacEncoder).toHaveBeenCalledOnce()
  })

  it('returns null when the WASM chunk cannot load', async () => {
    env.native = false
    vi.doMock('@mediabunny/aac-encoder', () => {
      throw new Error('chunk failed to load')
    })
    const { resolveAacEncoder } = await load()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveAacEncoder(CONFIG)).toBeNull()
  })
})
