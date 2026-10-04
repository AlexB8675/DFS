import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chunkContext, journalBatchContext, uuidBytes } from './context.ts'
import { FRAME_OVERHEAD, FrameError, openFrame, readFrameHeader, sealFrame } from './frame.ts'
import { fromSha256Hex, sha256, toHex } from './hash.ts'
import { generateDek, importAesKey, MasterKeys, type AesKey } from './keys.ts'

const versionId = '0192f3a4-5b6c-7d8e-9f00-112233445566'
const otherVersionId = '0192f3a4-5b6c-7d8e-9f00-112233445567'

describe('frames (DESIGN §7.3)', () => {
  let key: AesKey

  beforeAll(async () => {
    key = await importAesKey(generateDek())
  })

  it('adds 38 bytes and round-trips', async () => {
    const plaintext = new TextEncoder().encode('hello, frames')
    const frame = await sealFrame(key, plaintext, chunkContext(versionId, 3))
    expect(FRAME_OVERHEAD).toBe(38)
    expect(frame.length).toBe(plaintext.length + 38)
    expect(readFrameHeader(frame)).toEqual({
      flags: 0,
      ciphertextLength: plaintext.length,
      frameLength: frame.length,
    })
    expect(await openFrame(key, frame, chunkContext(versionId, 3))).toEqual(plaintext)
  })

  it('rejects a frame moved to another chunk, version or kind of object', async () => {
    const frame = await sealFrame(key, new Uint8Array([1, 2, 3]), chunkContext(versionId, 0))
    for (const context of [
      chunkContext(versionId, 1),
      chunkContext(otherVersionId, 0),
      journalBatchContext(0),
    ]) {
      await expect(openFrame(key, frame, context)).rejects.toBeInstanceOf(FrameError)
    }
  })

  it('rejects any flipped byte, header included', async () => {
    const context = chunkContext(versionId, 0)
    const frame = await sealFrame(key, new Uint8Array(64).fill(7), context)
    // The flags byte, a nonce byte, a ciphertext byte and a tag byte.
    for (const position of [5, 12, 30, frame.length - 1]) {
      const tampered = frame.slice()
      tampered[position] = (tampered[position] ?? 0) ^ 0x01
      await expect(openFrame(key, tampered, context)).rejects.toBeInstanceOf(FrameError)
    }
    const truncated = frame.subarray(0, frame.length - 1)
    await expect(openFrame(key, truncated, context)).rejects.toThrow(/header says/)
  })

  it('rejects another key', async () => {
    const context = chunkContext(versionId, 0)
    const frame = await sealFrame(key, new Uint8Array(8), context)
    const other = await importAesKey(generateDek())
    await expect(openFrame(other, frame, context)).rejects.toBeInstanceOf(FrameError)
  })
})

describe('master keys and wrapped DEKs', () => {
  let dir: string
  let keys: MasterKeys

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dfs-keys-'))
    await MasterKeys.createFile(path.join(dir, 'master-key.json'))
    keys = await MasterKeys.fromFile(path.join(dir, 'master-key.json'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('never overwrites an existing key file', async () => {
    await expect(MasterKeys.createFile(path.join(dir, 'master-key.json'))).rejects.toThrow()
  })

  it('unwraps a DEK only for the version it was wrapped for', async () => {
    const dek = generateDek()
    const wrapped = await keys.wrapDek(dek, uuidBytes(versionId))
    expect(wrapped.length).toBe(60)

    const unwrapped = await keys.unwrapDek(wrapped, keys.currentId, uuidBytes(versionId))
    const frame = await sealFrame(unwrapped, new Uint8Array([9]), chunkContext(versionId, 0))
    const original = await importAesKey(dek)
    expect(await openFrame(original, frame, chunkContext(versionId, 0))).toEqual(
      new Uint8Array([9]),
    )

    await expect(
      keys.unwrapDek(wrapped, keys.currentId, uuidBytes(otherVersionId)),
    ).rejects.toThrow()
    await expect(keys.unwrapDek(wrapped, 'k9', uuidBytes(versionId))).rejects.toThrow(/k9/)
  })
})

describe('hashing', () => {
  it('matches the SHA-256 of a known input', async () => {
    const digest = await sha256(new TextEncoder().encode('abc'))
    expect(toHex(digest)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(fromSha256Hex(toHex(digest))).toEqual(digest)
    expect(fromSha256Hex('not hex')).toBeNull()
  })
})
