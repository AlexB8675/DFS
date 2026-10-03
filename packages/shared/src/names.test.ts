import { describe, expect, it } from 'vitest'
import { MAX_NAME_LENGTH, nameKey, normalizeName, splitExtension, validateName } from './names.ts'

describe('normalizeName', () => {
  it('trims and applies NFC', () => {
    expect(normalizeName('  café.txt ')).toBe('café.txt')
  })
})

describe('nameKey', () => {
  it('treats case and Unicode forms as equal', () => {
    expect(nameKey('Photo.JPG')).toBe(nameKey('photo.jpg'))
    expect(nameKey('café')).toBe(nameKey('café'))
  })
})

describe('validateName', () => {
  it('accepts ordinary names', () => {
    expect(validateName('Holiday photos 2024')).toBeNull()
    expect(validateName('.env.example')).toBeNull()
  })

  it.each([
    ['', 'Enter a name.'],
    ['.', 'This name is reserved.'],
    ['..', 'This name is reserved.'],
    ['a/b', 'Names cannot contain / or \\.'],
    ['a\\b', 'Names cannot contain / or \\.'],
    ['tab\there', 'Names cannot contain control characters.'],
  ])('rejects %j', (name, message) => {
    expect(validateName(name)).toBe(message)
  })

  it('enforces the length limit', () => {
    expect(validateName('x'.repeat(MAX_NAME_LENGTH))).toBeNull()
    expect(validateName('x'.repeat(MAX_NAME_LENGTH + 1))).not.toBeNull()
  })
})

describe('splitExtension', () => {
  it('splits on the last dot', () => {
    expect(splitExtension('report.final.pdf')).toEqual({ base: 'report.final', extension: '.pdf' })
  })

  it('keeps dotfiles and extensionless names whole', () => {
    expect(splitExtension('.gitignore')).toEqual({ base: '.gitignore', extension: '' })
    expect(splitExtension('Makefile')).toEqual({ base: 'Makefile', extension: '' })
  })
})
