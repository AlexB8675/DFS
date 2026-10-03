import { describe, expect, it } from 'vitest'
import { formatBytes, formatCount, formatDate } from './format'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [10 * 1024 ** 2, '10.0 MB'],
    [250 * 1024 ** 3, '250 GB'],
    [3.2 * 1024 ** 4, '3.2 TB'],
  ])('formats %d bytes as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected)
  })
})

describe('formatDate', () => {
  const now = new Date(2026, 9, 3, 15, 30)

  it('uses relative wording for the last hour', () => {
    expect(formatDate(new Date(2026, 9, 3, 15, 29, 45).toISOString(), now)).toBe('Just now')
    expect(formatDate(new Date(2026, 9, 3, 15, 18).toISOString(), now)).toBe('12 minutes ago')
  })

  it('says Yesterday for the previous calendar day', () => {
    expect(formatDate(new Date(2026, 9, 2, 9, 0).toISOString(), now)).toBe('Yesterday')
  })

  it('falls back to a calendar date', () => {
    const result = formatDate(new Date(2025, 2, 4).toISOString(), now)
    expect(result).toContain('2025')
  })
})

describe('formatCount', () => {
  it('pluralizes', () => {
    expect(formatCount(1, 'item')).toBe('1 item')
    expect(formatCount(1204, 'item')).toMatch(/^1.204 items$/)
  })
})
