import { ReadError } from '@dfs/player'
import { describe, expect, it } from 'vitest'
import { failureOf } from './play-failure'

function readError(details: { status: number }): ReadError {
  return new ReadError('The server refused the read', { fatal: true, status: details.status })
}

describe('failureOf', () => {
  it('takes the engine’s refusal and its reason', () => {
    expect(failureOf({ refusal: 'Its moov is cut short', reason: 'damaged' })).toEqual({
      message: 'Its moov is cut short',
      reason: 'damaged',
      read: false,
    })
  })

  it('marks a read the server refused for good, so the page asks /playback what happened', () => {
    expect(failureOf(readError({ status: 412 }))).toMatchObject({ reason: null, read: true })
  })

  it('keeps any other error’s message', () => {
    expect(failureOf(new Error('boom'))).toEqual({ message: 'boom', reason: null, read: false })
  })

  it('keeps the text of anything else', () => {
    expect(failureOf('odd')).toEqual({ message: 'odd', reason: null, read: false })
  })
})
