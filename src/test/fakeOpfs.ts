// In-memory stand-in for the origin-private file system, for the export sink
// tests (opfsExports.test.ts, exportSink.test.ts). jsdom has no OPFS; this
// models only what opfsExports.ts relies on:
//
//   - `navigator.storage.getDirectory()` → root → `getDirectoryHandle('exports')`
//     (NotFoundError without `create`, until created), `estimate()`.
//   - Directory: `getFileHandle(name, { create })`, `removeEntry(name)`, `keys()`.
//   - `FileSystemFileHandle.prototype.createWritable` exists (feature detect);
//     the writable takes positioned `{ type: 'write', data, position }` writes
//     into a swap buffer that only close() commits to the file — like Chrome.
//     abort() drops the swap.
//   - `getFile()` returns the committed bytes as a File with an empty type
//     (what Firefox's OPFS hands back).
//
// Knobs: `refuseDirectory` (private window: getDirectory rejects),
// `refuseWritable` (createWritable rejects), `failWritesAfterBytes` (a write
// past this many bytes rejects with QuotaExceededError), `failClose`
// (close rejects with QuotaExceededError — Safari's copy-in running out).
// `log` records close / abort / remove per file name.
//
//   const fs = installFakeOpfs()
//   ...
//   fs.uninstall()   // afterEach

import { vi } from 'vitest'

export interface FakeOpfs {
  // Committed bytes per name in `exports/`.
  files: Map<string, Uint8Array>
  log: string[]
  quota: number
  usage: number
  refuseDirectory: boolean
  refuseWritable: boolean
  failWritesAfterBytes: number | null
  failClose: boolean
  uninstall(): void
}

interface WriteParams {
  type: 'write'
  data: Uint8Array
  position: number
}

const notFound = (name: string): DOMException =>
  new DOMException(`${name} not found`, 'NotFoundError')
const quotaExceeded = (): DOMException => new DOMException('Quota exceeded', 'QuotaExceededError')

export function installFakeOpfs(): FakeOpfs {
  let exportsDirExists = false
  const fs: FakeOpfs = {
    files: new Map(),
    log: [],
    quota: 10 * 1024 ** 3,
    usage: 0,
    refuseDirectory: false,
    refuseWritable: false,
    failWritesAfterBytes: null,
    failClose: false,
    uninstall: () => {
      vi.unstubAllGlobals()
      Reflect.deleteProperty(navigator, 'storage')
    },
  }

  class FakeFileHandle {
    readonly kind = 'file'
    constructor(readonly name: string) {}

    async getFile(): Promise<File> {
      const data = fs.files.get(this.name)
      if (!data) throw notFound(this.name)
      return new File([data.slice()], this.name)
    }

    async createWritable(): Promise<WritableStream<WriteParams>> {
      if (fs.refuseWritable) {
        throw new DOMException('Writable refused', 'NoModificationAllowedError')
      }
      const { name } = this
      let swap = new Uint8Array(0)
      let written = 0
      return new WritableStream<WriteParams>({
        write: (chunk) => {
          written += chunk.data.byteLength
          if (fs.failWritesAfterBytes !== null && written > fs.failWritesAfterBytes) {
            throw quotaExceeded()
          }
          const end = chunk.position + chunk.data.byteLength
          if (end > swap.length) {
            const grown = new Uint8Array(end) // zero-fills a gap, like the spec
            grown.set(swap)
            swap = grown
          }
          swap.set(chunk.data, chunk.position)
        },
        close: () => {
          if (fs.failClose) throw quotaExceeded()
          fs.files.set(name, swap)
          fs.log.push(`close ${name}`)
        },
        abort: () => {
          fs.log.push(`abort ${name}`)
        },
      })
    }
  }

  const exportsDir = {
    kind: 'directory',
    name: 'exports',
    async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
      if (!fs.files.has(name)) {
        if (!opts?.create) throw notFound(name)
        fs.files.set(name, new Uint8Array(0))
      }
      return new FakeFileHandle(name)
    },
    async removeEntry(name: string): Promise<void> {
      if (!fs.files.delete(name)) throw notFound(name)
      fs.log.push(`remove ${name}`)
    },
    async *keys(): AsyncGenerator<string> {
      for (const name of [...fs.files.keys()]) yield name
    },
  }

  const root = {
    kind: 'directory',
    name: '',
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      if (name !== 'exports') throw notFound(name)
      if (!exportsDirExists && !opts?.create) throw notFound(name)
      exportsDirExists = true
      return exportsDir
    },
  }

  vi.stubGlobal('FileSystemFileHandle', FakeFileHandle)
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      getDirectory: async () => {
        if (fs.refuseDirectory) throw new DOMException('Security error', 'SecurityError')
        return root
      },
      estimate: async () => ({ quota: fs.quota, usage: fs.usage }),
    },
  })
  return fs
}

// jsdom's Blob has no arrayBuffer(); FileReader does it.
export function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}
