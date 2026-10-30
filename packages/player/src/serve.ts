// The worker's side of the store (DESIGN.md §10.4; the iron-clad spec §4.7). A play's
// disk store runs here, in a worker of its own, which holds the key that seals the
// blocks and the access handle of the file that keeps them: the page never has
// either, and only ever asks. A sync access handle is not re-entrant, so each
// request runs to its end before the next one starts, whatever the order the page
// sent them in. A request that fails is answered with an error, and nothing that
// the page sends can stop the worker from answering the next.

import { StoreError } from './errors.ts'
import { BLOCK_BYTES } from './limits.ts'
import { dataOf, idOf, parseRequest } from './protocol.ts'
import type {
  Endpoint,
  OpenDirectory,
  OkReply,
  PlayDirectory,
  PlayLock,
  StoreReply,
  StoreRequest,
  WireError,
  WireErrorKind,
} from './protocol.ts'
import { newPlayKey, openBlock, sealBlock } from './seal.ts'
import type { PlayKey } from './seal.ts'
import { CoreStore } from './store.ts'
import type { SlotFile } from './store.ts'

/** The most bytes that `crypto.getRandomValues` fills in a call: it throws a `QuotaExceededError` for more. */
const RANDOM_CHUNK_BYTES = 65_536

/** A play that the worker serves: its store, the directory that holds its file, and the release of its lock. */
interface Session {
  store: CoreStore
  directory: PlayDirectory
  release: () => void
}

/** An answer, and the buffers whose ownership goes to the page with it. */
interface Answer {
  reply: StoreReply
  transfer?: ArrayBuffer[]
}

/** Whether a failure is the browser's refusal of a write for lack of space. */
function isQuota(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError'
}

/** What a failure is called on the wire: a store's own kind, `range` for a caller's mistake, `quota` for a full disk, and otherwise `fallback`. */
function wireError(error: unknown, fallback: WireErrorKind): WireError {
  const message = error instanceof Error ? error.message : 'it did not say why'
  if (error instanceof StoreError) return { kind: error.kind, message }
  if (error instanceof RangeError) return { kind: 'range', message }
  if (isQuota(error)) return { kind: 'quota', message }
  return { kind: fallback, message }
}

/** The failure of the trial of the file: a full disk is `quota`, and whatever else it was, the file is `refused`. */
function trialFailure(error: unknown): StoreError {
  const reason = error instanceof Error ? error.message : 'it did not say why'
  if (isQuota(error)) {
    return new StoreError('quota', `the private file has no room to try a block: ${reason}`)
  }
  return new StoreError('refused', `the private file failed a trial of a block: ${reason}`)
}

/** Whether two runs of bytes are the same. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let at = 0; at < a.length; at += 1) {
    if (a[at] !== b[at]) return false
  }
  return true
}

/**
 * Tries the file before the play relies on it: seals a block's worth of random bytes,
 * writes it in the first slot, reads it back, opens it and compares, and then empties
 * the file. A browser that opens a file and cannot use it (a private window, a handle
 * that fails at once) says so here, and not in the middle of the play. The trial is
 * made in the first slot and not the last, because a write at the last would make
 * the file as long as the cap (up to 2 GiB), and the file system would zero-fill the
 * gap. A disk that is too full for the play is judged from the quota, and one that
 * fills during the play shrinks the cap.
 */
async function tryFile(file: SlotFile, key: PlayKey): Promise<void> {
  try {
    const plain = new Uint8Array(BLOCK_BYTES)
    for (let at = 0; at < plain.length; at += RANDOM_CHUNK_BYTES) {
      globalThis.crypto.getRandomValues(plain.subarray(at, at + RANDOM_CHUNK_BYTES))
    }
    const sealed = await sealBlock(key, 0, plain)
    const written = file.write(sealed, { at: 0 })
    if (written !== sealed.length) {
      throw new Error(`the file took ${written} of the ${sealed.length} bytes`)
    }
    const back = new Uint8Array(sealed.length)
    const read = file.read(back, { at: 0 })
    if (read !== back.length) throw new Error(`the file gave ${read} of the ${back.length} bytes`)
    const opened = await openBlock(key, 0, back)
    if (!sameBytes(opened, plain))
      throw new Error('the file gave back other bytes than it was given')
    file.truncate(0)
  } catch (error) {
    throw trialFailure(error)
  }
}

class StoreServer {
  readonly #endpoint: Endpoint
  readonly #openDirectory: OpenDirectory
  readonly #lock: PlayLock
  #session: Session | null = null
  /** The end of the last request that was accepted: the next starts when it settles. It never rejects. */
  #chain: Promise<void> = Promise.resolve()

  constructor(endpoint: Endpoint, openDirectory: OpenDirectory, lock: PlayLock) {
    this.#endpoint = endpoint
    this.#openDirectory = openDirectory
    this.#lock = lock
    endpoint.addEventListener('message', (event) => {
      this.#receive(dataOf(event))
    })
    endpoint.start?.()
  }

  /** Reads a message, and queues the request that it holds. A message with no request in it is answered if it can be, and dropped if not. */
  #receive(data: unknown): void {
    const request = parseRequest(data)
    if (request === null) {
      const id = idOf(data)
      if (id !== null) {
        this.#send({
          id,
          ok: false,
          error: { kind: 'range', message: 'the message is not a request that the store knows' },
        })
      }
      return
    }
    this.#chain = this.#chain.then(() => this.#handle(request))
  }

  /** Sends an answer. If the answer itself cannot be sent, the page is told so in a smaller one, and if that fails the page is gone. */
  #send(reply: StoreReply, transfer: ArrayBuffer[] = []): void {
    try {
      this.#endpoint.postMessage(reply, transfer)
    } catch (error) {
      try {
        this.#endpoint.postMessage(
          { id: reply.id, ok: false, error: wireError(error, 'disk') } satisfies StoreReply,
          [],
        )
      } catch {
        // Neither answer got through, so there is nobody left to tell.
      }
    }
  }

  /** Runs a request to its end, and answers it. It does not reject: a failure is the answer. */
  async #handle(request: StoreRequest): Promise<void> {
    let answer: Answer | null
    try {
      answer = await this.#run(request)
    } catch (error) {
      // A position has no answer to carry its failure in: it is dropped, and the page validated it first.
      if (request.type === 'position') return
      const reply: StoreReply = {
        id: request.id,
        ok: false,
        error: wireError(error, request.type === 'open' ? 'refused' : 'disk'),
      }
      // A write that fails has still changed the store, so the page is told how it stands.
      if (request.type === 'write' && this.#session !== null)
        reply.stats = this.#session.store.stats()
      answer = { reply }
    }
    if (answer !== null) this.#send(answer.reply, answer.transfer)
  }

  /** The store of the play that is open, or a `closed` error when none is. */
  #store(): CoreStore {
    if (this.#session === null) throw new StoreError('closed', 'no play is open on this worker')
    return this.#session.store
  }

  async #run(request: StoreRequest): Promise<Answer | null> {
    switch (request.type) {
      case 'open':
        return { reply: await this.#open(request.id, request) }
      case 'write': {
        const store = this.#store()
        const outcome = await store.write(request.offset, request.bytes)
        return { reply: { id: request.id, ok: true, type: 'write', outcome, stats: store.stats() } }
      }
      case 'read': {
        const bytes = await this.#store().read(request.start, request.end)
        return {
          reply: { id: request.id, ok: true, type: 'read', bytes },
          transfer: bytes === null ? [] : [bytes.buffer],
        }
      }
      case 'position':
        this.#store().setPosition(request.offset)
        return null
      case 'close':
        await this.#close()
        return { reply: { id: request.id, ok: true, type: 'close' } }
    }
  }

  /**
   * Opens a play. The lock comes first, so that a cleanup in another tab cannot remove
   * the directory while it opens. Then the directory and its file, the key that is made
   * for the play, and the store; and last the trial of the file. A failure anywhere undoes
   * what was done, in the reverse order, and is answered.
   */
  async #open(
    id: number,
    options: { playId: string; fileSize: number; capBytes: number },
  ): Promise<OkReply> {
    if (this.#session !== null) {
      throw new StoreError('refused', 'this worker already serves a play, and serves one at a time')
    }
    const release = await this.#lock(options.playId)
    let directory: PlayDirectory | null = null
    let file: SlotFile | null = null
    let store: CoreStore | null = null
    try {
      directory = await this.#openDirectory(options.playId)
      file = await directory.openSlotFile()
      const key = await newPlayKey()
      store = new CoreStore({
        backend: { kind: 'disk', file, key },
        fileSize: options.fileSize,
        capBytes: options.capBytes,
      })
      await tryFile(file, key)
      this.#session = { store, directory, release }
      return { id, ok: true, type: 'open', capBytes: store.capBytes, stats: store.stats() }
    } catch (error) {
      if (store !== null) {
        await store.close()
      } else if (file !== null) {
        try {
          file.close()
        } catch {
          // The file is let go of whether or not it says so.
        }
      }
      if (directory !== null) {
        try {
          await directory.remove()
        } catch {
          // A directory that stays is removed by the next start of the app, which cleans up what is left.
        }
      }
      release()
      throw error
    }
  }

  /** Closes the store and its file, removes the directory, and releases the lock, in that order. The lock is released whatever else happens. */
  async #close(): Promise<void> {
    const session = this.#session
    if (session === null) return
    this.#session = null
    try {
      await session.store.close()
      try {
        await session.directory.remove()
      } catch {
        // The lock is released below, so the next start of the app removes what is left.
      }
    } finally {
      session.release()
    }
  }
}

/**
 * Serves a play's disk store on `endpoint`, which is the worker's own scope (or a port
 * of it). Directories are opened with `openDirectory`, and a play's lock is taken with
 * `lock`. One play is served at a time, and a play can be served again once it closed.
 */
export function serveStore(endpoint: Endpoint, openDirectory: OpenDirectory, lock: PlayLock): void {
  new StoreServer(endpoint, openDirectory, lock)
}
