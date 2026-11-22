import { describe, expect, it } from 'vitest'
import { failureProblem, problemKind, refusalText, type RefusalReason } from './problems'

const OTHER_PLAYER = 'Open it in another player, VLC say, or download it.'

/** The description of each refusal, keyed by reason, with 'null' for no reason. */
const COPY: Record<RefusalReason | 'null', string> = {
  codec: `This browser can’t play this video’s format in the page. ${OTHER_PLAYER}`,
  'unsupported-codec': `This browser can’t play this video’s format in the page. ${OTHER_PLAYER}`,
  damaged:
    'Its file looks damaged or cut short, so the page can’t read it. Another player may still play it, or download it.',
  'external-data':
    'Its picture or sound is kept in another file, which isn’t here. Download it to play it where that file is.',
  'edit-list': `This video was trimmed in a way the page can’t play yet. ${OTHER_PLAYER}`,
  fragmented: `This video is stored in fragments, which the page can’t play yet. ${OTHER_PLAYER}`,
  'several-descriptions': `This video changes its format partway through, which the page can’t play. ${OTHER_PLAYER}`,
  'no-picture': 'This file has no picture to show. Open it in another player, or download it.',
  null: `This browser can’t open this file. ${OTHER_PLAYER}`,
}

describe('the panel for a file the page refuses', () => {
  it.each(Object.entries(COPY))('says what is wrong with a %s file', (reason, description) => {
    expect(refusalText(reason === 'null' ? null : (reason as RefusalReason))).toEqual({
      title: 'This video can’t play here',
      description,
    })
  })
})

describe('what a failure after the first frame shows', () => {
  it('shows the stopped panel, with the engine’s sentence, when the play could not go on', () => {
    expect(
      failureProblem({
        elementError: null,
        engine: { failedOn: 'play', error: 'The sound’s buffer ends at 10.000 s' },
      }),
    ).toEqual({ kind: 'stopped', detail: 'The sound’s buffer ends at 10.000 s' })
  })
  it('shows the network panel when a read failed', () => {
    expect(
      failureProblem({ elementError: null, engine: { failedOn: 'read', error: 'gone' } }),
    ).toEqual({ kind: 'network' })
  })
  it('shows the network panel for the element’s network error', () => {
    expect(failureProblem({ elementError: { code: 2, message: 'x' }, engine: null })).toEqual({
      kind: 'network',
    })
  })
  it('shows the decode panel for the element’s decode error', () => {
    expect(
      failureProblem({ elementError: { code: 3, message: 'bad frame' }, engine: null }),
    ).toEqual({ kind: 'decode', detail: 'bad frame' })
  })
  it('shows the unsupported panel, with no reason, for another element error', () => {
    expect(failureProblem({ elementError: { code: 4, message: 'no' }, engine: null })).toEqual({
      kind: 'unsupported',
      detail: 'no',
      reason: null,
    })
  })
  it('names a stopped play as other in the report’s kinds', () => {
    expect(problemKind({ kind: 'stopped', detail: 'x' })).toBe('other')
  })
})
