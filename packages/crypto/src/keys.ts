import type { webcrypto } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

// Envelope encryption (DESIGN.md §7.3): every file version (and every journal
// batch or backup manifest) gets its own random data key (DEK). Only the DEK
// wrapped with a master key is stored, together with that key's ID.
//
// A wrapped DEK is `nonce (12) | ciphertext (32) | tag (16)`, with additional
// data `"dfs1-dek" | key_id length (1) | key_id | binding`, where the binding
// is the version ID (16 bytes) or the object's frame context. A wrapped DEK
// copied onto another version therefore fails to unwrap.

/** An AES-256-GCM key held by WebCrypto: a master key or a data key. */
export type AesKey = webcrypto.CryptoKey

const KEY_BYTES = 32
const NONCE_BYTES = 12
const LABEL = new TextEncoder().encode('dfs1-dek')

/**
 * The master key file: the current key's ID, and every key by ID, current
 * and retired, as base64. Retired keys must stay, since old journal batches
 * and backups are wrapped with them.
 */
const keyFileSchema = z
  .object({
    current: z.string().regex(/^[\w.-]{1,32}$/),
    keys: z.record(z.string(), z.base64()),
  })
  .refine((file) => file.current in file.keys, 'The current key is missing from "keys".')

export class MasterKeys {
  readonly currentId: string
  readonly #keys: ReadonlyMap<string, AesKey>
  /** For signing short-lived tokens such as share unlock cookies; derived, never stored. */
  readonly #macKey: AesKey

  private constructor(currentId: string, keys: ReadonlyMap<string, AesKey>, macKey: AesKey) {
    this.currentId = currentId
    this.#keys = keys
    this.#macKey = macKey
  }

  static async fromFile(file: string): Promise<MasterKeys> {
    const parsed = keyFileSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    const keys = new Map<string, AesKey>()
    let macKey: AesKey | null = null
    for (const [id, encoded] of Object.entries(parsed.keys)) {
      const raw = Buffer.from(encoded, 'base64')
      if (raw.length !== KEY_BYTES) throw new Error(`Master key "${id}" is not 256 bits.`)
      keys.set(id, await importAesKey(raw))
      if (id === parsed.current) macKey = await deriveMacKey(raw)
    }
    if (!macKey) throw new Error('The current master key is missing.')
    return new MasterKeys(parsed.current, keys, macKey)
  }

  /** An HMAC-SHA-256 of `data`, with a key derived from the current master key. */
  async sign(data: string): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.sign('HMAC', this.#macKey, new TextEncoder().encode(data)),
    )
  }

  /** Whether `mac` is `sign(data)`, compared in constant time. */
  async verify(data: string, mac: Uint8Array): Promise<boolean> {
    return crypto.subtle.verify('HMAC', this.#macKey, mac, new TextEncoder().encode(data))
  }

  /** Writes a new key file with one random key. Development only: production keys are made and backed up by hand. */
  static async createFile(file: string): Promise<void> {
    const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
    const contents = { current: 'k1', keys: { k1: Buffer.from(key).toString('base64') } }
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  }

  /** Wraps a DEK with the current master key, bound to `binding`. */
  async wrapDek(dek: Uint8Array, binding: Uint8Array): Promise<Uint8Array> {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: wrapAad(this.currentId, binding) },
      this.#key(this.currentId),
      dek,
    )
    const wrapped = new Uint8Array(NONCE_BYTES + sealed.byteLength)
    wrapped.set(nonce, 0)
    wrapped.set(new Uint8Array(sealed), NONCE_BYTES)
    return wrapped
  }

  /** Unwraps a DEK into a key for frames. Fails for another binding or a tampered DEK. */
  async unwrapDek(wrapped: Uint8Array, keyId: string, binding: Uint8Array): Promise<AesKey> {
    const raw = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: wrapped.subarray(0, NONCE_BYTES),
        additionalData: wrapAad(keyId, binding),
      },
      this.#key(keyId),
      wrapped.subarray(NONCE_BYTES),
    )
    return importAesKey(new Uint8Array(raw))
  }

  #key(id: string): AesKey {
    const key = this.#keys.get(id)
    if (!key) throw new Error(`Master key "${id}" is not in the key file.`)
    return key
  }
}

/** A fresh 256-bit data key. */
export function generateDek(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES))
}

export function importAesKey(raw: Uint8Array): Promise<AesKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** HKDF from a master key to an HMAC key, so signing never uses the encryption key itself. */
async function deriveMacKey(raw: Uint8Array): Promise<AesKey> {
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('dfs1-mac'),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  )
}

function wrapAad(keyId: string, binding: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(keyId)
  const aad = new Uint8Array(LABEL.length + 1 + id.length + binding.length)
  aad.set(LABEL, 0)
  aad[LABEL.length] = id.length
  aad.set(id, LABEL.length + 1)
  aad.set(binding, LABEL.length + 1 + id.length)
  return aad
}
