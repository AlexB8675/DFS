import { describe, expect, it } from 'vitest'
import { ReadError } from '../read.ts'
import { failedOnOf } from './failed-on.ts'

describe('failedOnOf', () => {
  it('is read for a read the server refused for good', () => {
    expect(failedOnOf(new ReadError('gone', { fatal: true, status: 404 }))).toBe('read')
  })
  it('is play for a read that failed but may be tried again, as a local store failure does', () => {
    expect(failedOnOf(new ReadError('let go', { fatal: false }))).toBe('play')
  })
  it('is play for any other error and for a refusal', () => {
    expect(failedOnOf(new Error('broken'))).toBe('play')
    expect(failedOnOf({ refusal: 'no', reason: 'codec' })).toBe('play')
    expect(failedOnOf('text')).toBe('play')
  })
})
