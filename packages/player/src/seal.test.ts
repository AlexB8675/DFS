import { describe, expect, it } from 'vitest'
import { StoreError } from './errors.ts'
import { BLOCK_BYTES } from './limits.ts'
import { SEAL_OVERHEAD, newPlayKey, openBlock, sealBlock } from './seal.ts'

// Every block the store keeps is sealed under a key made for the play, with a new
// nonce on every write, and bound to its index (DESIGN.md §10.4; the iron-clad
// spec §4.7). A block that is damaged, moved to another index or opened under
// another key does not open.

/** A generator of numbers in [0, 1) from a seed (mulberry32): the same bytes on every run and every machine. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

/** `length` bytes from a seed, the same on every run. */
function bytesOf(seed: number, length: number): Uint8Array<ArrayBuffer> {
  const next = generator(seed)
  const bytes = new Uint8Array(length)
  for (let at = 0; at < length; at += 1) bytes[at] = Math.floor(next() * 256)
  return bytes
}

/** The error that `attempt` fails with, or a failure of the test if it succeeds. */
async function failureOf(attempt: Promise<unknown>): Promise<unknown> {
  try {
    await attempt
  } catch (error) {
    return error
  }
  throw new Error('the attempt was expected to fail and did not')
}

/** Expects `attempt` to fail as a block that does not open: a `StoreError` of kind `sealed`. */
async function expectSealed(attempt: Promise<unknown>): Promise<void> {
  const error = await failureOf(attempt)
  expect(error).toBeInstanceOf(StoreError)
  expect((error as StoreError).kind).toBe('sealed')
}

describe('StoreError', () => {
  it('carries its kind, its message and its name', () => {
    const error = new StoreError('quota', 'the browser has no room')
    expect(error).toBeInstanceOf(Error)
    expect(error.kind).toBe('quota')
    expect(error.message).toBe('the browser has no room')
    expect(error.name).toBe('StoreError')
  })
})

describe('the key of a play', () => {
  it('is AES-GCM of 256 bits, for sealing and opening only', async () => {
    const key = await newPlayKey()
    expect(key.algorithm).toEqual({ name: 'AES-GCM', length: 256 })
    expect(key.type).toBe('secret')
    expect(key.usages.toSorted()).toEqual(['decrypt', 'encrypt'])
  })

  it('cannot be exported', async () => {
    const key = await newPlayKey()
    expect(key.extractable).toBe(false)
    await expect(globalThis.crypto.subtle.exportKey('raw', key)).rejects.toThrow()
  })

  it('is a new key on every call', async () => {
    const plain = bytesOf(1, 64)
    const sealed = await sealBlock(await newPlayKey(), 0, plain)
    await expectSealed(openBlock(await newPlayKey(), 0, sealed))
  })
})

describe('sealBlock and openBlock', () => {
  it('returns the bytes of a whole block after a round trip', async () => {
    const key = await newPlayKey()
    const plain = bytesOf(2, BLOCK_BYTES)
    const sealed = await sealBlock(key, 7, plain)
    const opened = await openBlock(key, 7, sealed)
    expect(opened.length).toBe(BLOCK_BYTES)
    expect(Buffer.from(opened).equals(Buffer.from(plain))).toBe(true)
  })

  it('does the round trip for a short last block and for an empty one', async () => {
    const key = await newPlayKey()
    for (const length of [0, 1, 4_321]) {
      const plain = bytesOf(3, length)
      const opened = await openBlock(key, 0, await sealBlock(key, 0, plain))
      expect([...opened]).toEqual([...plain])
    }
  })

  it('adds the IV and the tag, and nothing else', async () => {
    expect(SEAL_OVERHEAD).toBe(28)
    const key = await newPlayKey()
    for (const length of [0, 1, 4_321, BLOCK_BYTES]) {
      const sealed = await sealBlock(key, 0, bytesOf(4, length))
      expect(sealed.length).toBe(length + SEAL_OVERHEAD)
    }
  })

  it('does not change the bytes it is given', async () => {
    const key = await newPlayKey()
    const plain = bytesOf(5, 1_000)
    const before = plain.slice()
    const sealed = await sealBlock(key, 0, plain)
    const sealedBefore = sealed.slice()
    await openBlock(key, 0, sealed)
    expect([...plain]).toEqual([...before])
    expect([...sealed]).toEqual([...sealedBefore])
  })

  it('begins every seal with a new IV, even for the same block and bytes', async () => {
    const key = await newPlayKey()
    const plain = bytesOf(6, 256)
    const ivs = new Set<string>()
    for (let run = 0; run < 16; run += 1) {
      const sealed = await sealBlock(key, 3, plain)
      ivs.add(Buffer.from(sealed.subarray(0, 12)).toString('hex'))
    }
    expect(ivs.size).toBe(16)
    const first = await sealBlock(key, 3, plain)
    const second = await sealBlock(key, 3, plain)
    expect([...first.subarray(0, 12)]).not.toEqual([...second.subarray(0, 12)])
    expect([...first.subarray(12)]).not.toEqual([...second.subarray(12)])
  })

  it('does not open when a byte of the ciphertext is changed', async () => {
    const key = await newPlayKey()
    const sealed = await sealBlock(key, 0, bytesOf(7, 512))
    const damaged = sealed.slice()
    damaged[12 + 100] = (damaged[12 + 100] ?? 0) ^ 0x01
    await expectSealed(openBlock(key, 0, damaged))
  })

  it('does not open when a byte of the tag is changed', async () => {
    const key = await newPlayKey()
    const sealed = await sealBlock(key, 0, bytesOf(8, 512))
    const damaged = sealed.slice()
    const last = damaged.length - 1
    damaged[last] = (damaged[last] ?? 0) ^ 0x80
    await expectSealed(openBlock(key, 0, damaged))
  })

  it('does not open when the IV is changed', async () => {
    const key = await newPlayKey()
    const sealed = await sealBlock(key, 0, bytesOf(9, 512))
    const damaged = sealed.slice()
    damaged[0] = (damaged[0] ?? 0) ^ 0x01
    await expectSealed(openBlock(key, 0, damaged))
  })

  it('does not open under another index', async () => {
    const key = await newPlayKey()
    const sealed = await sealBlock(key, 4, bytesOf(10, 512))
    await expectSealed(openBlock(key, 5, sealed))
    await expectSealed(openBlock(key, 0, sealed))
    // Indexes that differ only in a high byte are told apart too.
    const far = await sealBlock(key, 2 ** 40 + 1, bytesOf(10, 512))
    await expectSealed(openBlock(key, 1, far))
    await expectSealed(openBlock(key, 2 ** 40 + 2, far))
    expect((await openBlock(key, 2 ** 40 + 1, far)).length).toBe(512)
  })

  it('does not open under another key', async () => {
    const sealed = await sealBlock(await newPlayKey(), 0, bytesOf(11, 512))
    await expectSealed(openBlock(await newPlayKey(), 0, sealed))
  })

  it('does not open when it is cut short', async () => {
    const key = await newPlayKey()
    const sealed = await sealBlock(key, 0, bytesOf(12, 512))
    await expectSealed(openBlock(key, 0, sealed.subarray(0, sealed.length - 1)))
  })

  it('does not open when it is shorter than the IV and the tag', async () => {
    const key = await newPlayKey()
    await expectSealed(openBlock(key, 0, new Uint8Array(0)))
    await expectSealed(openBlock(key, 0, new Uint8Array(SEAL_OVERHEAD - 1)))
  })

  it('refuses an index that is not a block index', async () => {
    const key = await newPlayKey()
    const plain = bytesOf(13, 16)
    const sealed = await sealBlock(key, 0, plain)
    for (const index of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await expect(sealBlock(key, index, plain)).rejects.toBeInstanceOf(RangeError)
      await expect(openBlock(key, index, sealed)).rejects.toBeInstanceOf(RangeError)
    }
  })
})
