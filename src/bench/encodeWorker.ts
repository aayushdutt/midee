// DedicatedWorker half of the `encodepar` bench suite (runner.ts): one
// VideoEncoder per worker, driven by the same loop the main-thread variant
// uses (encodeLoop.ts). Protocol, so all workers start encoding together:
//   main → { kind: 'setup', config, pool (transferred VideoFrames), frames, fps }
//   worker → { kind: 'ready' }
//   main → { kind: 'go' }
//   worker → { kind: 'done', result } | { kind: 'error', error }
// The worker closes its pool when done.

import { type EncodeRunResult, runEncodeLoop } from './encodeLoop'

interface Setup {
  kind: 'setup'
  config: VideoEncoderConfig
  pool: VideoFrame[]
  frames: number
  fps: number
}

export type EncodeWorkerReply =
  | { kind: 'ready' }
  | { kind: 'done'; result: EncodeRunResult }
  | { kind: 'error'; error: string }

// tsconfig's lib is DOM-only; type just the worker surface used here.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage(msg: EncodeWorkerReply): void
}

let setup: Setup | null = null

scope.onmessage = (e: MessageEvent) => {
  const msg = e.data as Setup | { kind: 'go' }
  if (msg.kind === 'setup') {
    setup = msg
    scope.postMessage({ kind: 'ready' })
    return
  }
  const s = setup
  if (!s) {
    scope.postMessage({ kind: 'error', error: 'go before setup' })
    return
  }
  runEncodeLoop(s)
    .then(
      (result) => scope.postMessage({ kind: 'done', result }),
      (err: unknown) => scope.postMessage({ kind: 'error', error: String(err) }),
    )
    .finally(() => {
      for (const f of s.pool) f.close()
    })
}
