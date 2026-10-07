import { readZip, readZipTimes } from '@dfs/contract'
import { describe, expect, it } from 'vitest'
import { writeZip, zipLength, zipTimeZone, type ZipEntry } from './zip.ts'

async function zipped(entries: ZipEntry[], options: Parameters<typeof writeZip>[1] = {}) {
  const parts: Buffer[] = []
  for await (const part of writeZip(entries, options)) parts.push(part)
  return new Uint8Array(Buffer.concat(parts))
}

function file(path: string, text: string, modifiedAt: Date): ZipEntry {
  const bytes = new TextEncoder().encode(text)
  return {
    path,
    modifiedAt,
    size: bytes.length,
    data: async function* () {
      yield await Promise.resolve(bytes)
    },
  }
}

const SUMMER = new Date('2026-07-01T12:00:00Z')

describe('ZIP archives (§6.2)', () => {
  it('writes the length zipLength said, with or without timestamps and ZIP64', async () => {
    const entries = [
      { path: 'Trip/', modifiedAt: SUMMER },
      file('Trip/now.txt', 'hello', SUMMER),
      file('Trip/ancient.txt', 'before 1901', new Date('1850-01-01T00:00:00Z')),
      file('Trip/future.txt', 'after 2038', new Date('2050-01-01T00:00:00Z')),
    ]
    expect((await zipped(entries)).length).toBe(zipLength(entries))
    // ZIP64 from the second entry on, as a 4 GiB file would make it.
    expect((await zipped(entries, { limit: 40 })).length).toBe(zipLength(entries, { limit: 40 }))
  })

  it('writes DOS times in the downloader’s time zone, and the UTC time beside them', async () => {
    const entries = () => [
      file('summer.txt', 's', SUMMER),
      file('winter.txt', 'w', new Date('2026-01-15T12:00:00Z')),
    ]
    const rome = readZipTimes(await zipped(entries(), { timeZone: 'Europe/Rome' }))
    expect(rome.get('summer.txt')).toEqual({
      dos: { year: 2026, month: 7, day: 1, hour: 14, minute: 0, second: 0 },
      unix: SUMMER.getTime() / 1000,
    })
    expect(rome.get('winter.txt')?.dos.hour).toBe(13)
    const utc = readZipTimes(await zipped(entries()))
    expect(utc.get('summer.txt')?.dos.hour).toBe(12)
    expect(readZip(await zipped(entries())).get('summer.txt')).toEqual(
      new TextEncoder().encode('s'),
    )
  })

  it('leaves out the UTC time it can’t hold, and keeps DOS times within 1980 to 2107', async () => {
    const times = readZipTimes(
      await zipped([
        file('ancient.txt', 'a', new Date('1850-06-01T00:00:00Z')),
        file('future.txt', 'f', new Date('2200-06-01T00:00:00Z')),
      ]),
    )
    expect(times.get('ancient.txt')).toEqual({
      dos: { year: 1980, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
      unix: null,
    })
    expect(times.get('future.txt')).toEqual({
      dos: { year: 2107, month: 12, day: 31, hour: 23, minute: 59, second: 58 },
      unix: null,
    })
  })

  it('takes a time zone the server knows, and UTC for any other', () => {
    expect(zipTimeZone('Europe/Rome')).toBe('Europe/Rome')
    expect(zipTimeZone('Not/A_Zone')).toBe('UTC')
    expect(zipTimeZone(undefined)).toBe('UTC')
  })
})
