// What the page and the store's worker say to one another (DESIGN.md §10.4; the
// iron-clad spec §4.7). The page asks, in numbered requests, and the worker answers
// each by its number, in whatever order it likes; a request to move the position is
// the one that is not answered. Nothing here is a worker: the same messages cross a
// real `Worker` in the browser and a `MessageChannel` in the tests, and both ends
// check what they receive, because a message is only data until it has been read.

import type { ByteRange } from '@dfs/mp4'
import type { StoreErrorKind } from './errors.ts'
import type { SlotFile, StoreStats, WriteOutcome } from './store.ts'

/** Where a play's files live: a directory of the private file system, or a stand-in for one. */
export interface PlayDirectory {
  /** Opens the play's file for synchronous reads and writes, creating it if it is not there. */
  openSlotFile(): Promise<SlotFile>
  /** Deletes the directory and the file in it. */
  remove(): Promise<void>
}

/** Opens the directory of a play, creating it if it is not there. */
export type OpenDirectory = (playId: string) => Promise<PlayDirectory>

/** Takes the lock of a play, and answers the function that releases it: a cleanup in another tab leaves a directory that is locked alone. */
export type PlayLock = (playId: string) => Promise<() => void>

/** The events of an endpoint that the store listens to. */
export type EndpointEventType = 'message' | 'error' | 'messageerror'

/**
 * One end of the conversation, by the calls that the store makes of it. A browser's
 * `Worker`, a worker's own scope, a `MessagePort` and Node's `MessagePort` all have
 * these, and none of their types is needed to say so. Only `ArrayBuffer`s are
 * transferred, and the list of them is always given, empty when there is none. A
 * `MessagePort` does not deliver until it is started, so `start` is called when there
 * is one.
 */
export interface Endpoint {
  postMessage(message: unknown, transfer: ArrayBuffer[]): void
  addEventListener(type: EndpointEventType, listener: (event: unknown) => void): void
  removeEventListener(type: EndpointEventType, listener: (event: unknown) => void): void
  start?(): void
}

/** The `data` of a `message` event, or undefined when the event has none. */
export function dataOf(event: unknown): unknown {
  return typeof event === 'object' && event !== null && 'data' in event ? event.data : undefined
}

/** What a failure is called on the wire: a kind of `StoreError`, or `range` for a `RangeError`, which is the caller's mistake and not the store's. */
export type WireErrorKind = StoreErrorKind | 'range'

/** A failure as it crosses: errors themselves do not. */
export interface WireError {
  kind: WireErrorKind
  message: string
}

/**
 * What the page asks of the worker. `open` and `close` bracket a play, `write` carries
 * its bytes (the buffer is transferred, not copied), and `position` is not answered.
 */
export type StoreRequest =
  | { id: number; type: 'open'; playId: string; fileSize: number; capBytes: number }
  | { id: number; type: 'write'; offset: number; bytes: Uint8Array }
  | { id: number; type: 'read'; start: number; end: number }
  | { type: 'position'; offset: number }
  | { id: number; type: 'close' }

/** A request that succeeded, by the type of the request it answers. */
export type OkReply =
  | { id: number; ok: true; type: 'open'; capBytes: number; stats: StoreStats }
  | { id: number; ok: true; type: 'write'; outcome: WriteOutcome; stats: StoreStats }
  | { id: number; ok: true; type: 'read'; bytes: Uint8Array | null }
  | { id: number; ok: true; type: 'close' }

/** A request that failed. A write that fails still says how the store stands, so that the page's `stats()` does not go stale. */
export interface ErrorReply {
  id: number
  ok: false
  error: WireError
  stats?: StoreStats
}

/** What the worker answers. */
export type StoreReply = OkReply | ErrorReply

/** Every kind a failure can be called on the wire, to tell one from a string that only looks like one. */
const WIRE_ERROR_KINDS: Record<WireErrorKind, true> = {
  sealed: true,
  disk: true,
  quota: true,
  closed: true,
  refused: true,
  'no-opfs': true,
  range: true,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isWireErrorKind(value: unknown): value is WireErrorKind {
  return typeof value === 'string' && Object.hasOwn(WIRE_ERROR_KINDS, value)
}

function isRange(value: unknown): value is ByteRange {
  return isRecord(value) && typeof value.start === 'number' && typeof value.end === 'number'
}

function isStats(value: unknown): value is StoreStats {
  return (
    isRecord(value) &&
    (value.backend === 'disk' || value.backend === 'memory') &&
    typeof value.capBytes === 'number' &&
    typeof value.storedBytes === 'number' &&
    typeof value.evictedBytes === 'number'
  )
}

function isOutcome(value: unknown): value is WriteOutcome {
  return (
    isRecord(value) &&
    typeof value.full === 'boolean' &&
    typeof value.evictedBytes === 'number' &&
    Array.isArray(value.evicted) &&
    value.evicted.every(isRange)
  )
}

/** The number a message asks to be answered by, or null when it has none. */
export function idOf(data: unknown): number | null {
  return isRecord(data) && typeof data.id === 'number' ? data.id : null
}

/**
 * The request a message holds, or null when it holds none. Its numbers are only
 * checked to be numbers: the store judges whether they are positions, and says so
 * with a `RangeError`.
 */
export function parseRequest(data: unknown): StoreRequest | null {
  if (!isRecord(data)) return null
  if (data.type === 'position') {
    return typeof data.offset === 'number' ? { type: 'position', offset: data.offset } : null
  }
  const id = idOf(data)
  if (id === null) return null
  switch (data.type) {
    case 'open':
      return typeof data.playId === 'string' &&
        typeof data.fileSize === 'number' &&
        typeof data.capBytes === 'number'
        ? {
            id,
            type: 'open',
            playId: data.playId,
            fileSize: data.fileSize,
            capBytes: data.capBytes,
          }
        : null
    case 'write':
      return typeof data.offset === 'number' && data.bytes instanceof Uint8Array
        ? { id, type: 'write', offset: data.offset, bytes: data.bytes }
        : null
    case 'read':
      return typeof data.start === 'number' && typeof data.end === 'number'
        ? { id, type: 'read', start: data.start, end: data.end }
        : null
    case 'close':
      return { id, type: 'close' }
    default:
      return null
  }
}

/** The answer a message holds, or null when it holds none. */
export function parseReply(data: unknown): StoreReply | null {
  const id = idOf(data)
  if (id === null || !isRecord(data)) return null
  if (data.ok === false) {
    const { error, stats } = data
    if (!isRecord(error) || !isWireErrorKind(error.kind) || typeof error.message !== 'string') {
      return null
    }
    const reply: ErrorReply = { id, ok: false, error: { kind: error.kind, message: error.message } }
    if (stats !== undefined) {
      if (!isStats(stats)) return null
      reply.stats = stats
    }
    return reply
  }
  if (data.ok !== true) return null
  switch (data.type) {
    case 'open':
      return typeof data.capBytes === 'number' && isStats(data.stats)
        ? { id, ok: true, type: 'open', capBytes: data.capBytes, stats: data.stats }
        : null
    case 'write':
      return isOutcome(data.outcome) && isStats(data.stats)
        ? { id, ok: true, type: 'write', outcome: data.outcome, stats: data.stats }
        : null
    case 'read':
      return data.bytes === null || data.bytes instanceof Uint8Array
        ? { id, ok: true, type: 'read', bytes: data.bytes }
        : null
    case 'close':
      return { id, ok: true, type: 'close' }
    default:
      return null
  }
}
