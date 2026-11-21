// The browser side of the play server (src/testing/play-server.ts; DESIGN.md §10.4): where it is, the
// files it has, and its control channel, each a small `fetch`. The suites that play files through
// it shape the network with `control` and read what it saw with `log`.

import { inject } from 'vitest'
import type { LogEntry, Network, PlayFile } from '../testing/provided.ts'

export type { Fault, LogEntry, Network, PlayFile } from '../testing/provided.ts'

/** The files of the corpus that the server has (none when there is no corpus): never a path. */
export function files(): PlayFile[] {
  return inject('playServer').files
}

/** Where a file is served, for a `video` or a `fetch`. */
export function fileUrl(id: string): string {
  return `${inject('playServer').base}/file/${encodeURIComponent(id)}`
}

function check(response: Response, what: string): void {
  if (!response.ok) throw new Error(`The play server answered ${what} with ${response.status}.`)
}

/**
 * Sets the network that the following requests see, replacing all of it: a field that is left out is no
 * limit, no wait and no fault, so `control({})` resets it. A `switch` fault acts at once. The body goes as
 * text/plain, which a page may send to another origin with no preflight.
 */
export async function control(net: Network): Promise<void> {
  const response = await fetch(`${inject('playServer').base}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(net),
  })
  check(response, 'a control')
}

/** The requests the server has seen, in order, since it began or since the log was last cleared. */
export async function log(): Promise<LogEntry[]> {
  const response = await fetch(`${inject('playServer').base}/log`)
  check(response, 'the log')
  return (await response.json()) as LogEntry[]
}

/** Forgets the requests seen so far. */
export async function clearLog(): Promise<void> {
  check(await fetch(`${inject('playServer').base}/log`, { method: 'DELETE' }), 'a log clear')
}
