import { describe, expect, it } from 'vitest'
import {
  canonicalShareToken,
  isShortCode,
  newShortCode,
  SHORT_CODE_ALPHABET,
} from './share-codes.ts'

describe('short share codes (§7.5, D46)', () => {
  it('draws from 34 characters, none a lookalike of another', () => {
    expect(new Set(SHORT_CODE_ALPHABET).size).toBe(34)
    for (const left of 'iloABCXYZ_.~') expect(SHORT_CODE_ALPHABET).not.toContain(left)
  })

  it('makes codes of six of them, every one used, a hyphen never at an end or doubled', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 3000; i += 1) {
      const code = newShortCode()
      expect(code).toHaveLength(6)
      expect(isShortCode(code)).toBe(true)
      expect(code).not.toMatch(/^-|-$|--/)
      for (const char of code) seen.add(char)
    }
    expect(seen.size).toBe(34)
  })

  it('reads capitals and lookalikes as the characters they stand for', () => {
    expect(canonicalShareToken('k7hm2q')).toBe('k7hm2q')
    expect(canonicalShareToken('K7HM2Q')).toBe('k7hm2q')
    expect(canonicalShareToken('O1lIoS')).toBe('01110s')
    expect(canonicalShareToken('ab-Cd1')).toBe('ab-cd1')
    expect(canonicalShareToken('XYZ-0W')).toBe('xyz-0w')
  })

  it('leaves every other token as it is', () => {
    for (const token of [
      'AbCdEfGhIjKlMnOpQrStUv',
      'no-such-link',
      'ab_cd1',
      'ab.cd1',
      'abcde',
      'abcdefg',
      '',
      '-abcd1',
      'abcd1-',
      'ab--c1',
      'ab cd1',
    ]) {
      expect(canonicalShareToken(token)).toBe(token)
      expect(isShortCode(token)).toBe(false)
    }
    expect(isShortCode('O1lIoS')).toBe(false)
    expect(isShortCode('K7HM2Q')).toBe(false)
  })
})
