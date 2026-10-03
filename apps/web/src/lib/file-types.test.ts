import { describe, expect, it } from 'vitest'
import { fileCategory } from './file-types'

describe('fileCategory', () => {
  it.each([
    ['clip', 'video/mp4', 'video'],
    ['report.pdf', 'application/octet-stream', 'pdf'],
    ['IMG_0001.HEIC', null, 'image'],
    ['IMG_0001.heic', '', 'image'],
    ['data.csv', 'text/csv', 'spreadsheet'],
    ['notes', 'text/plain', 'text'],
    ['archive.tar.gz', null, 'archive'],
    ['Makefile', null, 'other'],
  ])('%s (%s) is %s', (name, mimeType, expected) => {
    expect(fileCategory(name, mimeType)).toBe(expected)
  })
})
