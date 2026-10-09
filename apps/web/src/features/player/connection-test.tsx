import { MAX_CONNECTION_TEST_BYTES } from '@dfs/shared'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api/client'
import { formatBitRate } from './diagnostics'

// How fast this device's connection to the server is (DESIGN.md §10.4):
// bytes from the VPS itself, not from Discord, read for a few seconds, so a
// slow play can be put down to the network or not.

/** Long enough to settle on a rate; short enough to wait for. */
const TEST_MS = 8000

interface Result {
  bitsPerSecond: number
  /** From asking to the first byte: the connection's latency, roughly. */
  firstByteMs: number
  done: boolean
}

/** Reads from a connection test (`path`) for up to `TEST_MS`, reporting the rate as it goes. */
async function testConnection(
  path: string,
  signal: AbortSignal,
  onProgress: (result: Result) => void,
): Promise<void> {
  const controller = new AbortController()
  const abort = () => {
    controller.abort()
  }
  signal.addEventListener('abort', abort)
  const asked = performance.now()
  try {
    const response = await apiFetch(path, {
      query: { bytes: MAX_CONNECTION_TEST_BYTES },
      signal: controller.signal,
    })
    const reader = response.body?.getReader()
    if (!reader) return
    const first = performance.now()
    let bytes = 0
    let last = 0
    for (;;) {
      const { done, value } = await reader.read()
      const at = performance.now()
      if (value) bytes += value.length
      const result = {
        bitsPerSecond: at > first ? (bytes * 8 * 1000) / (at - first) : 0,
        firstByteMs: first - asked,
      }
      if (done || at - first >= TEST_MS) {
        onProgress({ ...result, done: true })
        break
      }
      if (at - last > 250) {
        last = at
        onProgress({ ...result, done: false })
      }
    }
    controller.abort()
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/**
 * A Details row's value: Test, then the rate. `path` is the user's test, or
 * a link's for its viewers (`connectionTestPath`).
 */
export function ConnectionTest({ path }: { path: string }) {
  const [result, setResult] = useState<Result | null>(null)
  const [failed, setFailed] = useState(false)
  const [running, setRunning] = useState(false)
  const stop = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      stop.current?.abort()
    },
    [],
  )

  function run() {
    stop.current?.abort()
    const controller = new AbortController()
    stop.current = controller
    setRunning(true)
    setFailed(false)
    setResult(null)
    testConnection(path, controller.signal, setResult)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true)
      })
      .finally(() => {
        setRunning(false)
      })
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      {result && (
        <span className="tabular-nums">
          {running && !result.done ? 'Testing… ' : ''}
          {formatBitRate(result.bitsPerSecond)}, first byte {Math.round(result.firstByteMs)} ms
        </span>
      )}
      {failed && <span className="text-destructive">Couldn’t test</span>}
      {!result && running && <span>Testing…</span>}
      {!running && (
        <Button variant="link" size="sm" className="h-auto p-0" onClick={run}>
          {result ? 'Test again' : 'Test'}
        </Button>
      )}
    </span>
  )
}
