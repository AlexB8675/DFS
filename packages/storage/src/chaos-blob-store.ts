import { setTimeout as sleep } from 'node:timers/promises'
import {
  BlobStoreError,
  type BlobStore,
  type BlobToStore,
  type PutResult,
  type StoredBlob,
} from './blob-store.ts'

export interface ChaosOptions {
  /** Chance that a call fails before doing anything (a 429, a 5xx, a timeout). */
  failureRate?: number
  /** Chance that a put succeeds but its answer is lost, so the caller sees an error. */
  lostResponseRate?: number
  /** Extra delay per call, in ms. */
  latencyMs?: number
  /** Replaceable for deterministic tests. */
  random?: () => number
}

/**
 * Wraps a store and makes it unreliable on purpose (DESIGN.md §17), to test
 * retries, idempotency and the reconciler under the faults Discord produces.
 */
export class ChaosBlobStore implements BlobStore {
  readonly #inner: BlobStore
  readonly #failureRate: number
  readonly #lostResponseRate: number
  readonly #latencyMs: number
  readonly #random: () => number

  constructor(inner: BlobStore, options: ChaosOptions = {}) {
    this.#inner = inner
    this.#failureRate = options.failureRate ?? 0.2
    this.#lostResponseRate = options.lostResponseRate ?? 0.05
    this.#latencyMs = options.latencyMs ?? 0
    this.#random = options.random ?? Math.random
  }

  async put(blob: BlobToStore, read: () => Promise<Uint8Array>): Promise<PutResult> {
    await this.#trouble('put')
    const stored = await this.#inner.put(blob, read)
    if (this.#random() < this.#lostResponseRate) {
      throw new BlobStoreError('Chaos: the blob was stored, but the answer was lost.', {
        retryable: true,
      })
    }
    return stored
  }

  async read(
    blob: StoredBlob,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    await this.#trouble('read')
    return this.#inner.read(blob, offset, length, signal)
  }

  async delete(blob: StoredBlob): Promise<void> {
    await this.#trouble('delete')
    await this.#inner.delete(blob)
  }

  async #trouble(operation: string): Promise<void> {
    if (this.#latencyMs > 0) await sleep(this.#latencyMs)
    if (this.#random() < this.#failureRate) {
      throw new BlobStoreError(`Chaos: ${operation} failed; try again.`, {
        retryable: true,
        retryAfterMs: 100,
      })
    }
  }
}
