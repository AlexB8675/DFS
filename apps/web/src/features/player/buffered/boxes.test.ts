import { describe, expect, it } from 'vitest'
import { mediaLayout, topLevelBoxes } from './boxes'

/** A box: a 32-bit size (or 1 and a 64-bit one when `large`), its type and `body` zero bytes. */
function box(type: string, body: number, large = false): Uint8Array {
  const header = large ? 16 : 8
  const bytes = new Uint8Array(header + body)
  const view = new DataView(bytes.buffer)
  if (large) {
    view.setUint32(0, 1)
    view.setBigUint64(8, BigInt(header + body))
  } else {
    view.setUint32(0, header + body)
  }
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i)
  return bytes
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** An 8-byte box header that claims `size` bytes in all, with only `body` of them present. */
function openBox(type: string, size: number, body: number): Uint8Array {
  const bytes = new Uint8Array(8 + body)
  new DataView(bytes.buffer).setUint32(0, size)
  for (let i = 0; i < 4; i += 1) bytes[4 + i] = type.charCodeAt(i)
  return bytes
}

describe('topLevelBoxes (§10.4)', () => {
  it('lists each box with its type, where it starts in the file and how long it is', () => {
    expect(topLevelBoxes(concat(box('ftyp', 24), box('free', 0)), 100)).toEqual([
      { type: 'ftyp', start: 100, size: 32 },
      { type: 'free', start: 132, size: 8 },
    ])
  })

  it('reads a 64-bit size', () => {
    expect(topLevelBoxes(box('mdat', 4, true), 0)).toEqual([{ type: 'mdat', start: 0, size: 20 }])
  })

  it('leaves out a header cut short', () => {
    expect(topLevelBoxes(concat(box('ftyp', 24), new Uint8Array(5)), 0)).toEqual([
      { type: 'ftyp', start: 0, size: 32 },
    ])
  })

  it('leaves out a 64-bit header cut short', () => {
    const cut = box('mdat', 4, true).subarray(0, 12)
    expect(topLevelBoxes(concat(box('ftyp', 24), cut), 0)).toEqual([
      { type: 'ftyp', start: 0, size: 32 },
    ])
  })

  it('lists a box whose body runs past the bytes', () => {
    const bytes = concat(box('ftyp', 24), openBox('mdat', 1_000_000, 0))
    expect(bytes.length).toBe(40)
    expect(topLevelBoxes(bytes, 0)).toEqual([
      { type: 'ftyp', start: 0, size: 32 },
      { type: 'mdat', start: 32, size: 1_000_000 },
    ])
  })

  it('lists a box that runs to the end of the file with no size, and nothing after it', () => {
    const open = box('mdat', 12)
    new DataView(open.buffer).setUint32(0, 0)
    expect(topLevelBoxes(concat(box('ftyp', 24), open, box('free', 0)), 0)).toEqual([
      { type: 'ftyp', start: 0, size: 32 },
      { type: 'mdat', start: 32, size: null },
    ])
  })

  it('stops at a box smaller than its own header', () => {
    const damaged = box('free', 0)
    new DataView(damaged.buffer).setUint32(0, 4)
    expect(topLevelBoxes(concat(box('ftyp', 24), damaged, box('moov', 0)), 0)).toEqual([
      { type: 'ftyp', start: 0, size: 32 },
    ])
  })
})

describe('mediaLayout (§10.4)', () => {
  it('finds a moov at the start and streams everything after it', () => {
    const head = concat(box('ftyp', 24), box('moov', 100), openBox('mdat', 5000, 40))
    const fileSize = 32 + 108 + 5000
    expect(mediaLayout(head, fileSize)).toEqual({
      moov: { start: 32, end: 140 },
      stream: { from: head.length, to: fileSize },
    })
  })

  it('streams from the end of a moov that reaches past the head', () => {
    const head = concat(box('ftyp', 24), openBox('moov', 100_000, 100))
    expect(mediaLayout(head, 500_000)).toEqual({
      moov: { start: 32, end: 100_032 },
      stream: { from: 100_032, to: 500_000 },
    })
  })

  it('takes a moov with no size to run to the end of the file', () => {
    const open = box('moov', 12)
    new DataView(open.buffer).setUint32(0, 0)
    expect(mediaLayout(concat(box('ftyp', 24), open), 1000)).toEqual({
      moov: { start: 32, end: 1000 },
      stream: { from: 1000, to: 1000 },
    })
  })

  it('finds a moov after the mdat when the head ends inside the mdat', () => {
    const mdatHeader = box('mdat', 0, true)
    new DataView(mdatHeader.buffer).setBigUint64(8, BigInt(899_776_512 - 32))
    const head = new Uint8Array(65_536)
    head.set(box('ftyp', 24))
    head.set(mdatHeader, 32)
    expect(mediaLayout(head, 899_853_995)).toEqual({
      moov: { start: 899_776_512, end: 899_853_995 },
      stream: { from: 65_536, to: 899_776_512 },
    })
  })

  it('is null for a file with neither a moov nor an mdat', () => {
    expect(mediaLayout(box('ftyp', 24), 32)).toBeNull()
  })

  it('is null when the mdat has no size, so no moov can be placed after it', () => {
    const open = box('mdat', 12)
    new DataView(open.buffer).setUint32(0, 0)
    expect(mediaLayout(concat(box('ftyp', 24), open), 1000)).toBeNull()
  })

  it('is null when the moov would start at or past the end of the file', () => {
    const head = concat(box('ftyp', 24), openBox('mdat', 1000, 40))
    expect(mediaLayout(head, 1032)).toBeNull()
  })
})
