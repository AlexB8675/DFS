import { access } from 'node:fs/promises'
import type { Config } from '@dfs/config'
import { MasterKeys, type AesKey } from '@dfs/crypto'
import type { FastifyBaseLogger } from 'fastify'

/**
 * The master keys (DESIGN.md §7.3). Development makes a key file on first
 * start; production never does, since its key is generated and backed up by
 * hand, and losing it loses every file.
 */
export async function loadMasterKeys(config: Config, log: FastifyBaseLogger): Promise<MasterKeys> {
  if (config.nodeEnv !== 'production' && !(await exists(config.masterKeyFile))) {
    await MasterKeys.createFile(config.masterKeyFile)
    log.warn({ file: config.masterKeyFile }, 'created a development master key')
  }
  return MasterKeys.fromFile(config.masterKeyFile)
}

/**
 * Unwrapped data keys of recent versions, so the parts of one upload don't
 * unwrap the same key again and again. Least recently used ones go first.
 */
export class DataKeyCache {
  readonly #keys = new Map<string, Promise<AesKey>>()
  readonly #capacity: number

  constructor(capacity = 256) {
    this.#capacity = capacity
  }

  get(versionId: string, unwrap: () => Promise<AesKey>): Promise<AesKey> {
    let key = this.#keys.get(versionId)
    if (key) {
      this.#keys.delete(versionId)
    } else {
      key = unwrap()
      // A failed unwrap isn't kept.
      const pending = key
      key.catch(() => {
        if (this.#keys.get(versionId) === pending) this.#keys.delete(versionId)
      })
    }
    this.#keys.set(versionId, key)
    if (this.#keys.size > this.#capacity) {
      const oldest = this.#keys.keys().next().value
      if (oldest !== undefined) this.#keys.delete(oldest)
    }
    return key
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}
