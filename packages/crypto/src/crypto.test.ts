import { createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chunkContext, journalBatchContext, uuidBytes } from './context.ts'
import {
  chunkFrameLayout,
  chunkFrameLength,
  FRAME_OVERHEAD,
  FrameError,
  openFrame,
  openSegment,
  readFrameHeader,
  sealChunkFrame,
  sealFrame,
  SEGMENT_BYTES,
} from './frame.ts'
import { fromSha256Hex, sha256, toHex } from './hash.ts'
import { generateDek, importAesKey, MasterKeys, type AesKey } from './keys.ts'
import { openObject, sealObject } from './object.ts'

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

  it('keeps the existing frame format interoperable with native AES-GCM', async () => {
    const raw = generateDek()
    const key = await importAesKey(raw)
    const context = chunkContext(versionId, 2)
    const plaintext = new Uint8Array([3, 1, 4, 1, 5])
    const header = Buffer.alloc(22)
    header.write('DFS1')
    header[4] = 1
    header.writeUInt32BE(plaintext.length, 6)
    header.fill(9, 10)
    const aad = Buffer.concat([header.subarray(0, 10), context])
    const cipher = createCipheriv('aes-256-gcm', raw, header.subarray(10))
    cipher.setAAD(aad)
    const existing = Buffer.concat([
      header,
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ])
    expect(await openFrame(key, existing, context)).toEqual(plaintext)

    const frame = await sealFrame(key, plaintext, context)
    const decipher = createDecipheriv('aes-256-gcm', raw, frame.subarray(10, 22))
    decipher.setAAD(Buffer.concat([frame.subarray(0, 10), context]))
    decipher.setAuthTag(frame.subarray(frame.length - 16))
    expect(
      new Uint8Array(Buffer.concat([decipher.update(frame.subarray(22, -16)), decipher.final()])),
    ).toEqual(plaintext)
  })

  it('handles empty plaintext and sliced buffers without exposing unrelated bytes', async () => {
    for (const size of [0, 1, 1024]) {
      const source = new Uint8Array(size + 16).fill(0xa5)
      const plaintext = source.subarray(7, 7 + size)
      plaintext.fill(3)
      const context = chunkContext(versionId, size)
      const frame = await sealFrame(key, plaintext, context, 7)
      expect(readFrameHeader(frame)).toMatchObject({
        flags: 7,
        ciphertextLength: size,
        frameLength: size + 38,
      })
      const backing = new Uint8Array(frame.length + 16).fill(0x5a)
      backing.set(frame, 5)
      expect(await openFrame(key, backing.subarray(5, 5 + frame.length), context)).toEqual(
        plaintext,
      )
      expect(backing[4]).toBe(0x5a)
      expect(backing[frame.length + 5]).toBe(0x5a)
    }
  })
})

describe('format 2 chunk frames (DESIGN §7.3, D37)', () => {
  let key: AesKey
  const context = chunkContext(versionId, 4)

  beforeAll(async () => {
    key = await importAesKey(generateDek())
  })

  function bytes(size: number): Uint8Array {
    return Uint8Array.from({ length: size }, (_, index) => (index * 7 + 3) % 251)
  }

  it('seals a chunk in 256 KiB segments and opens it whole, at every edge of a segment', async () => {
    expect(SEGMENT_BYTES).toBe(256 * 1024)
    for (const size of [
      0,
      1,
      SEGMENT_BYTES - 1,
      SEGMENT_BYTES,
      SEGMENT_BYTES + 1,
      3 * SEGMENT_BYTES + 5,
    ]) {
      const plaintext = bytes(size)
      const frame = await sealChunkFrame(key, plaintext, context)
      const segments = Math.max(1, Math.ceil(size / SEGMENT_BYTES))
      expect(frame.length).toBe(14 + size + 28 * segments)
      expect(chunkFrameLength(size)).toBe(frame.length)
      expect(readFrameHeader(frame)).toEqual({
        flags: 0,
        ciphertextLength: size,
        frameLength: frame.length,
      })
      expect(await openFrame(key, frame, context)).toEqual(plaintext)
      expect(chunkFrameLayout(size, frame.length)?.segments).toBe(segments)
    }
  })

  it('opens any segment alone, from the layout its sizes give', async () => {
    const plaintext = bytes(3 * SEGMENT_BYTES + 5)
    const frame = await sealChunkFrame(key, plaintext, context)
    const layout = chunkFrameLayout(plaintext.length, frame.length)
    if (!layout) throw new Error('Not a format 2 layout.')
    for (let index = 0; index < layout.segments; index += 1) {
      const start = layout.segmentStart(index)
      const segment = frame.subarray(start, start + layout.segmentLength(index))
      const from = layout.plaintextStart(index)
      expect(await openSegment(key, layout, index, segment, context)).toEqual(
        plaintext.subarray(from, from + layout.plaintextSize(index)),
      )
    }
    expect(layout.segmentOf(0)).toBe(0)
    expect(layout.segmentOf(SEGMENT_BYTES)).toBe(1)
    expect(layout.segmentOf(plaintext.length - 1)).toBe(3)
  })

  it('tells format 1 from format 2 by their sizes, and refuses sizes that fit neither', () => {
    expect(chunkFrameLayout(1000, 1038)).toBeNull()
    expect(chunkFrameLayout(1000, chunkFrameLength(1000))).not.toBeNull()
    expect(() => chunkFrameLayout(1000, 1040)).toThrow(FrameError)
  })

  it('fails a changed byte anywhere, in the segment it is in', async () => {
    const plaintext = bytes(2 * SEGMENT_BYTES + 9)
    const frame = await sealChunkFrame(key, plaintext, context)
    const layout = chunkFrameLayout(plaintext.length, frame.length)
    if (!layout) throw new Error('Not a format 2 layout.')
    for (const at of [0, 5, 13, 14, 20, 30, layout.segmentStart(1) + 100, frame.length - 1]) {
      const changed = Uint8Array.from(frame)
      changed[at] = (changed[at] ?? 0) ^ 1
      await expect(openFrame(key, changed, context)).rejects.toThrow(FrameError)
    }
    // A segment's own check catches it, with the rest untouched.
    const changed = Uint8Array.from(frame)
    const second = layout.segmentStart(1)
    changed[second + 50] = (changed[second + 50] ?? 0) ^ 1
    const segment = (index: number, of: Uint8Array) =>
      of.subarray(
        layout.segmentStart(index),
        layout.segmentStart(index) + layout.segmentLength(index),
      )
    await expect(openSegment(key, layout, 1, segment(1, changed), context)).rejects.toThrow(
      FrameError,
    )
    expect(await openSegment(key, layout, 0, segment(0, changed), context)).toEqual(
      plaintext.subarray(0, SEGMENT_BYTES),
    )
  })

  it('fails segments swapped, dropped, or taken from another chunk', async () => {
    const plaintext = bytes(3 * SEGMENT_BYTES)
    const frame = await sealChunkFrame(key, plaintext, context)
    const layout = chunkFrameLayout(plaintext.length, frame.length)
    if (!layout) throw new Error('Not a format 2 layout.')
    const segment = (index: number) =>
      frame.subarray(
        layout.segmentStart(index),
        layout.segmentStart(index) + layout.segmentLength(index),
      )
    // Swapped: each is checked as the segment it stands in for.
    await expect(openSegment(key, layout, 0, segment(1), context)).rejects.toThrow(FrameError)
    const swapped = Uint8Array.from(frame)
    swapped.set(segment(1), layout.segmentStart(0))
    swapped.set(segment(0), layout.segmentStart(1))
    await expect(openFrame(key, swapped, context)).rejects.toThrow(FrameError)
    // Dropped: the last segment cut off, the header told of two.
    const header = Buffer.from(frame.subarray(0, 14))
    header.writeUInt32BE(2 * SEGMENT_BYTES, 6)
    const cut = Buffer.concat([header, frame.subarray(14, layout.segmentStart(2))])
    expect(readFrameHeader(cut).frameLength).toBe(cut.length)
    await expect(openFrame(key, cut, context)).rejects.toThrow(FrameError)
    // From another chunk, or another version.
    await expect(openFrame(key, frame, chunkContext(versionId, 5))).rejects.toThrow(FrameError)
    await expect(openFrame(key, frame, chunkContext(otherVersionId, 4))).rejects.toThrow(FrameError)
    await expect(
      openSegment(key, layout, 0, segment(0), chunkContext(versionId, 5)),
    ).rejects.toThrow(FrameError)
  })

  it('refuses another segment size, and a segment of the wrong length', async () => {
    const frame = await sealChunkFrame(key, bytes(10), context)
    const other = Buffer.from(frame)
    other.writeUInt32BE(SEGMENT_BYTES * 2, 10)
    expect(() => readFrameHeader(other)).toThrow(FrameError)
    const layout = chunkFrameLayout(10, frame.length)
    if (!layout) throw new Error('Not a format 2 layout.')
    await expect(
      openSegment(key, layout, 0, frame.subarray(14, frame.length - 1), context),
    ).rejects.toThrow('wrong size')
  })

  it('pins the format: a segment opens with native AES-GCM', async () => {
    const raw = generateDek()
    const native = await importAesKey(raw)
    const plaintext = bytes(SEGMENT_BYTES + 3)
    const frame = await sealChunkFrame(native, plaintext, context)
    const header = frame.subarray(0, 14)
    expect(Buffer.from(header.subarray(0, 5)).toString('latin1')).toBe('DFS1')
    // The second, and last, segment: nonce, 3 bytes, tag.
    const start = 14 + SEGMENT_BYTES + 28
    const aad = Buffer.concat([header, Buffer.from([0, 0, 0, 1, 1]), context])
    const decipher = createDecipheriv('aes-256-gcm', raw, frame.subarray(start, start + 12))
    decipher.setAAD(aad)
    decipher.setAuthTag(frame.subarray(frame.length - 16))
    expect(
      new Uint8Array(
        Buffer.concat([decipher.update(frame.subarray(start + 12, -16)), decipher.final()]),
      ),
    ).toEqual(plaintext.subarray(SEGMENT_BYTES))
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

  it('seals an object with its own key in front, and opens it only for its context', async () => {
    const plaintext = new TextEncoder().encode('journal records')
    const sealed = await sealObject(keys, plaintext, journalBatchContext(7), 1)
    expect(sealed[0]).toBe(2)
    expect(new TextDecoder().decode(sealed.subarray(1, 3))).toBe('k1')
    const opened = await openObject(keys, sealed, journalBatchContext(7))
    expect(new TextDecoder().decode(opened.plaintext)).toBe('journal records')
    expect(opened.flags).toBe(1)

    // Passed off as another batch, it fails, key and frame alike.
    await expect(openObject(keys, sealed, journalBatchContext(8))).rejects.toThrow(FrameError)
    for (const at of [5, sealed.length - 1]) {
      const tampered = sealed.slice()
      tampered[at] = (tampered[at] ?? 0) ^ 1
      await expect(openObject(keys, tampered, journalBatchContext(7))).rejects.toThrow(FrameError)
    }
    await expect(openObject(keys, sealed.subarray(0, 20), journalBatchContext(7))).rejects.toThrow(
      FrameError,
    )
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

describe('signing', () => {
  it('verifies its own signatures, and nothing else', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dfs-keys-'))
    await MasterKeys.createFile(path.join(dir, 'keys.json'))
    const keys = await MasterKeys.fromFile(path.join(dir, 'keys.json'))
    const mac = await keys.sign('share:1:0')
    expect(await keys.verify('share:1:0', mac)).toBe(true)
    expect(await keys.verify('share:1:1', mac)).toBe(false)
    await rm(dir, { recursive: true, force: true })
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
