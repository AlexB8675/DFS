import { describe, expect, it } from 'vitest'
import { mergeRequests } from './requests.ts'
import type { Request } from './requests.ts'

// What the pump is asked to do (DESIGN.md §10.4): requests are merged, never dropped, so a seek's target and
// its play intent outlive the refeed or reopen that comes after it.

function request(partial: Partial<Request>): Request {
  return { kind: 'refeed', to: 0, told: false, seek: false, playing: false, ...partial }
}

describe('mergeRequests', () => {
  it('is the later request when there is no earlier one', () => {
    const later = request({ kind: 'seek', to: 4, told: true, seek: true, playing: true })
    expect(mergeRequests(null, later)).toEqual(later)
  })

  it('takes the stronger kind: a refeed is under a seek, which is under a reopen', () => {
    expect(mergeRequests(request({ kind: 'seek' }), request({ kind: 'refeed' })).kind).toBe('seek')
    expect(mergeRequests(request({ kind: 'refeed' }), request({ kind: 'reopen' })).kind).toBe(
      'reopen',
    )
    expect(mergeRequests(request({ kind: 'reopen' }), request({ kind: 'seek' })).kind).toBe(
      'reopen',
    )
  })

  it("keeps a viewer's seek target and intent through a later refeed that is not told", () => {
    const seek = request({ kind: 'seek', to: 8, told: true, seek: true, playing: true })
    const refeed = request({ kind: 'refeed', to: 3, told: false, playing: false })
    const merged = mergeRequests(seek, refeed)
    expect(merged).toMatchObject({ kind: 'seek', to: 8, told: true, seek: true, playing: true })
  })

  it('takes the later told target over an earlier one', () => {
    const first = request({ kind: 'seek', to: 8, told: true, seek: true, playing: true })
    const second = request({ kind: 'seek', to: 2, told: true, seek: true, playing: false })
    expect(mergeRequests(first, second)).toMatchObject({ to: 2, playing: false })
  })

  it("takes the later's place when neither is told, and ORs the seek", () => {
    const first = request({ kind: 'refeed', to: 3 })
    const second = request({ kind: 'reopen', to: 5, playing: true })
    expect(mergeRequests(first, second)).toMatchObject({ kind: 'reopen', to: 5, playing: true })
    const withSeek = mergeRequests(request({ seek: true }), request({ seek: false }))
    expect(withSeek.seek).toBe(true)
  })
})
