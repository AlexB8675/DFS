import { describe, expect, it } from 'vitest'
import { formatBucket, formatValue, timeTicks, totalFormat, valueTicks } from './scales'

const KB = 1024
const MB = 1024 ** 2

describe('valueTicks', () => {
  it('reaches just past the largest value in three or four round steps', () => {
    expect(valueTicks(26, 'count')).toEqual([0, 10, 20, 30])
    expect(valueTicks(0.7, 'perSecond')).toEqual([0, 0.25, 0.5, 0.75])
  })

  it('steps bytes in binary multiples, so the labels are round', () => {
    expect(
      valueTicks(1.4 * MB, 'bytesPerSecond').map((tick) => formatValue(tick, 'bytesPerSecond')),
    ).toEqual(['0 B/s', '512 KB/s', '1.0 MB/s', '1.5 MB/s'])
  })

  it('makes per-minute rates round per minute', () => {
    expect(valueTicks(5 / 60, 'perMinute').map((tick) => formatValue(tick, 'perMinute'))).toEqual([
      '0/min',
      '2/min',
      '4/min',
      '6/min',
    ])
  })

  it('gives an empty graph a small top, and shares a 0–100% scale', () => {
    expect(valueTicks(0, 'bytes')).toEqual([0, KB])
    expect(valueTicks(0.4, 'percent')).toEqual([0, 0.5, 1])
    // CPU can use more than one core.
    expect(valueTicks(1.6, 'percent').at(-1)).toBeGreaterThanOrEqual(1.6)
  })
})

describe('formatValue', () => {
  it.each([
    [0, 'ms', '0 ms'],
    [4.25, 'ms', '4.3 ms'],
    [212, 'ms', '212 ms'],
    [2400, 'ms', '2.4 s'],
    [0.5, 'percent', '50%'],
    [0.004, 'percent', '0.4%'],
    [1 / 60, 'perMinute', '1/min'],
    [12_400, 'count', '12.4K'],
  ] as const)('shows %d as %s %s', (value, format, expected) => {
    expect(formatValue(value, format)).toBe(expected)
  })

  it('totals rates over a range', () => {
    expect(totalFormat('bytesPerSecond')).toBe('bytes')
    expect(totalFormat('perMinute')).toBe('count')
    expect(totalFormat('ms')).toBe('ms')
  })
})

describe('formatBucket', () => {
  it('says when the last bucket covers only part of its time so far', () => {
    const start = new Date(2026, 9, 5, 10).getTime()
    const hour = formatBucket(start, 3600)
    expect(hour).not.toContain('so far')
    const partial = formatBucket(start, 3600, start + 25 * 60_000)
    expect(partial).toMatch(/so far$/)
    expect(partial).toContain('25')
    expect(formatBucket(start, 86_400, start + 3_600_000)).toMatch(/so far$/)
  })
})

describe('timeTicks', () => {
  it('falls on round local times', () => {
    const start = new Date(2026, 9, 5, 9, 7).getTime()
    const ticks = timeTicks(start, start + 60 * 60_000, 5)
    expect(ticks.map((tick) => new Date(tick).getMinutes())).toEqual([15, 30, 45, 0])
  })

  it('falls on midnights for a week, and on the first of months for a year', () => {
    const start = new Date(2026, 9, 5, 13).getTime()
    const week = timeTicks(start, start + 7 * 86_400_000, 8)
    expect(week.every((tick) => new Date(tick).getHours() === 0)).toBe(true)
    expect(week).toHaveLength(7)
    const year = timeTicks(start, start + 365 * 86_400_000, 7)
    expect(year.every((tick) => new Date(tick).getDate() === 1)).toBe(true)
    expect(year.length).toBeLessThanOrEqual(7)
  })
})
