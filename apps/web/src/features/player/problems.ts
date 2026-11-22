import type { EngineRefusal } from '@dfs/player'
import type { PlayProblemKind } from '@dfs/shared'
import { codecLabel } from './codecs'

/** Why the engine refuses a file before its first frame (§10.4). */
export type RefusalReason = EngineRefusal['reason']

/** What stands in the way of playing. */
export type Problem =
  /** The browser can't decode the picture (from the media info). */
  | { kind: 'codec'; codec: string }
  /** The browser couldn't decode the file. */
  | { kind: 'decode'; detail: string }
  /**
   * The browser or the engine couldn't open the file (the buffered play, before its first frame,
   * too). The `reason` is the engine's refusal, and null when there is none (an element's error).
   */
  | { kind: 'unsupported'; detail: string; reason: RefusalReason | null }
  /**
   * The page doesn't play it (`pagePlay`, §10.4, D45): the file's kind, its picture or its
   * first sound track (the `codec`), or this browser. Derived from the decision, not stored,
   * and with no element, so nothing is played or reported.
   */
  | {
      kind: 'elsewhere'
      reason: 'format' | 'picture' | 'sound' | 'browser'
      codec: string | null
    }
  /** A read of the file failed while it played. */
  | { kind: 'network' }
  /** The play stopped after its first frame, for a reason a retry won't change (§4.8). */
  | { kind: 'stopped'; detail: string }
  /** The file has another version since it started. */
  | { kind: 'replaced'; versionId: string }

/** Why it doesn't play, in a few words, for the play's report. */
export function problemText(problem: Problem): string {
  switch (problem.kind) {
    case 'codec':
      return `can’t decode ${problem.codec} video`
    case 'unsupported':
    case 'decode':
      return `${problem.kind}: ${problem.detail}`
    case 'stopped':
      return `stopped: ${problem.detail}`
    case 'network':
      return 'a read failed while playing'
    case 'replaced':
      return 'replaced while playing'
    case 'elsewhere':
      // Nothing is followed, so nothing is reported with it: this only completes the switch.
      return `not played in the page: ${problem.reason}`
  }
}

/** What kind of failure it is, for the graphs (§16). */
export function problemKind(problem: Problem): PlayProblemKind {
  switch (problem.kind) {
    case 'codec':
      return 'codec'
    case 'unsupported':
    case 'decode':
      return 'file'
    case 'network':
      return 'read'
    case 'stopped':
    case 'replaced':
      return 'other'
    case 'elsewhere':
      // Never reported (see `problemText`); a codec's, a file's or the browser's, all the same.
      if (problem.reason === 'picture' || problem.reason === 'sound') return 'codec'
      return problem.reason === 'format' ? 'file' : 'other'
  }
}

/** What the panel says of a file the engine refuses (§10.4), by the engine's reason. */
export function refusalText(reason: RefusalReason | null): { title: string; description: string } {
  const title = 'This video can’t play here'
  const elsewhere = 'Open it in another player, VLC say, or download it.'
  switch (reason) {
    case 'codec':
    case 'unsupported-codec':
      return {
        title,
        description: `This browser can’t play this video’s format in the page. ${elsewhere}`,
      }
    case 'damaged':
      return {
        title,
        description:
          'Its file looks damaged or cut short, so the page can’t read it. Another player may still play it, or download it.',
      }
    case 'external-data':
      return {
        title,
        description:
          'Its picture or sound is kept in another file, which isn’t here. Download it to play it where that file is.',
      }
    case 'edit-list':
      return {
        title,
        description: `This video was trimmed in a way the page can’t play yet. ${elsewhere}`,
      }
    case 'fragmented':
      return {
        title,
        description: `This video is stored in fragments, which the page can’t play yet. ${elsewhere}`,
      }
    case 'several-descriptions':
      return {
        title,
        description: `This video changes its format partway through, which the page can’t play. ${elsewhere}`,
      }
    case 'no-picture':
      return {
        title,
        description: 'This file has no picture to show. Open it in another player, or download it.',
      }
    case null:
      return { title, description: `This browser can’t open this file. ${elsewhere}` }
  }
}

/**
 * The panel for a play that failed after its first frame (§4.8): the element's own error when
 * it has one, else the engine's. A read the server refused for good is the network panel, and
 * any other failure of the play is the stopped one, which a retry won't change.
 */
export function failureProblem({
  elementError,
  engine,
}: {
  elementError: { code: number; message: string } | null
  engine: { failedOn: 'read' | 'play' | null; error: string | null } | null
}): Problem {
  if (elementError) {
    // MediaError's codes: 2 is the network, 3 a decode.
    if (elementError.code === 3) return { kind: 'decode', detail: elementError.message }
    if (elementError.code === 2) return { kind: 'network' }
    return { kind: 'unsupported', detail: elementError.message, reason: null }
  }
  if (engine?.failedOn === 'play') {
    return { kind: 'stopped', detail: engine.error ?? 'The play could not go on' }
  }
  return { kind: 'network' }
}

/** What the panel says of a video the page doesn't play (§10.4, D45), and why. */
export function elsewhereText({ reason, codec }: Extract<Problem, { kind: 'elsewhere' }>): {
  title: string
  description: string
} {
  const format = {
    title: 'This video can’t play here',
    description:
      'This browser can’t play this kind of file in the page. Open it in another player, or download it.',
  }
  switch (reason) {
    case 'format':
      return format
    case 'picture':
      // `pagePlay` always names the codec of a picture it refuses; with none, the 'format' wording.
      return codec === null
        ? format
        : {
            title: format.title,
            description: `This browser can’t play ${codecLabel(codec)} video. Open it in another player, or download it.`,
          }
    case 'sound':
      // The same for the sound.
      return codec === null
        ? format
        : {
            title: 'This video’s sound can’t play here',
            description: `This browser can’t play its ${codecLabel(codec)} sound. Open it in another player, which plays all of it, or download it.`,
          }
    case 'browser':
      return {
        title: format.title,
        description: 'This browser can’t stream videos. Open it in another player, or download it.',
      }
  }
}
