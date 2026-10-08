import { describe, expect, it } from 'vitest'
import { decodeText, formatJson } from './text'

const utf8 = (text: string) => new TextEncoder().encode(text)

function utf16(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0xfeff, littleEndian)
  for (let index = 0; index < text.length; index += 1)
    view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian)
  return bytes
}

describe('decodeText (§10.3)', () => {
  it('reads UTF-8, with or without a byte-order mark', () => {
    expect(decodeText(utf8('Grüße, 世界'), false)).toEqual({ binary: false, text: 'Grüße, 世界' })
    const marked = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('hi')])
    expect(decodeText(marked, false)).toEqual({ binary: false, text: 'hi' })
  })

  it('reads UTF-16 when its byte-order mark says so, either way round', () => {
    expect(decodeText(utf16('Grüße', true), false)).toEqual({ binary: false, text: 'Grüße' })
    expect(decodeText(utf16('Grüße', false), false)).toEqual({ binary: false, text: 'Grüße' })
  })

  it('finds binary: a NUL byte, or mostly not UTF-8', () => {
    expect(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]), false)).toEqual({
      binary: true,
    })
    expect(decodeText(new Uint8Array([0x89, 0xff, 0xfe, 0x80, 0x41, 0x90, 0xc3]), false)).toEqual({
      binary: true,
    })
  })

  it('keeps text with a few characters that aren’t UTF-8, as Latin-1 has', () => {
    const latin1 = new Uint8Array([...utf8('Le caf'), 0xe9, ...utf8(' est ouvert tous les jours.')])
    const decoded = decodeText(latin1, false)
    expect(decoded).toEqual({ binary: false, text: 'Le caf\uFFFD est ouvert tous les jours.' })
  })

  it('leaves out a character cut at the cap', () => {
    // “€” is three bytes; the cap fell after the first two.
    const bytes = utf8('price: €').slice(0, -1)
    expect(decodeText(bytes, true)).toEqual({ binary: false, text: 'price: ' })
    // A whole file that ends badly does show it.
    expect(decodeText(bytes, false)).toEqual({ binary: false, text: 'price: \uFFFD' })
  })
})

describe('formatJson', () => {
  it('lays JSON out two spaces to a level, empty objects and arrays as they are', () => {
    expect(formatJson('{"a":[1,2,{}],"b":{"c":null,"d":[]}}')).toBe(
      [
        '{',
        '  "a": [',
        '    1,',
        '    2,',
        '    {}',
        '  ],',
        '  "b": {',
        '    "c": null,',
        '    "d": []',
        '  }',
        '}',
      ].join('\n'),
    )
  })

  it('changes nothing but the spaces between tokens', () => {
    const text = '{ "id": 12345678901234567890, "s": "a, b: {c} \\"[d]\\"", "e": 1.50e+3 }'
    expect(formatJson(text)).toBe(
      '{\n  "id": 12345678901234567890,\n  "s": "a, b: {c} \\"[d]\\"",\n  "e": 1.50e+3\n}',
    )
  })

  it('says when it isn’t JSON', () => {
    expect(formatJson('{"a": 1,}')).toBeNull()
    expect(formatJson('// a comment\n{}')).toBeNull()
  })
})
