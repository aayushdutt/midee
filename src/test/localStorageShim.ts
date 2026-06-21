// Shared in-memory `localStorage` shim for unit tests.
//
// Vitest runs under jsdom which provides a real `localStorage`, but several
// suites prefer a deterministic, isolated Map-backed store they can clear
// between tests without touching other globals. This is the helper previously
// copy-pasted into progress.test.ts, ExerciseRunner.test.ts, and
// persistence.test.ts.
//
// Usage:
//   let uninstall: () => void
//   beforeAll(() => { uninstall = installLocalStorageShim() })
//   afterAll(() => { uninstall() })
//   beforeEach(() => { localStorage.clear() })

export function installLocalStorageShim(): () => void {
  const data = new Map<string, string>()
  const shim: Storage = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => {
      data.delete(k)
    },
    setItem: (k, v) => {
      data.set(k, String(v))
    },
  }
  const prev = (globalThis as { localStorage?: Storage }).localStorage
  ;(globalThis as { localStorage?: Storage }).localStorage = shim
  return () => {
    if (prev === undefined) delete (globalThis as { localStorage?: Storage }).localStorage
    else (globalThis as { localStorage?: Storage }).localStorage = prev
  }
}
