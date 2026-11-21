// The engine's seeks as the timeline tells them (DESIGN.md §10.4; the iron-clad spec §4.8): a seek is sent
// when it starts, with `ms` null, and again when its picture comes, with the time to picture, even if that is
// after the deadline. A seek with no picture by `SEEK_DEADLINE_MS` is reported once (the engine sends the error
// and refeeds). It tracks the latest seek only: a new seek replaces the one before, which sends nothing more.
// It decides and says; applying the seek (feeding again) is the play's.

import type { TimelineEventInput } from '@dfs/shared'
import { SEEK_DEADLINE_MS } from '../limits.ts'
import { HAVE_CURRENT_DATA, framesShown } from './video.ts'

/** The seek that has no picture yet. */
interface Pending {
  to: number
  inWindow: boolean
  startedAt: number
  /** The frames shown when it began: the picture is a frame past them. */
  frames: number
  /** True once the deadline was reported. */
  late: boolean
}

export class Seeks {
  readonly #video: HTMLVideoElement
  readonly #say: (event: TimelineEventInput) => void
  readonly #now: () => number
  #pending: Pending | null = null

  constructor(
    video: HTMLVideoElement,
    say: (event: TimelineEventInput) => void,
    now: () => number,
  ) {
    this.#video = video
    this.#say = say
    this.#now = now
  }

  /** Whether a seek has no picture yet. */
  get pending(): boolean {
    return this.#pending !== null
  }

  /** A seek to `to` (seconds) began: sent with no time, and watched for its picture. */
  begin(to: number, inWindow: boolean): void {
    this.#pending = {
      to,
      inWindow,
      startedAt: this.#now(),
      frames: framesShown(this.#video),
      late: false,
    }
    this.#say({ type: 'seek', to, inWindow, ms: null })
  }

  /** Moves the target of the seek that waits: the engine put the start elsewhere (a target past the end of the file, a start where every track has frames). */
  retarget(to: number): void {
    if (this.#pending !== null) this.#pending.to = to
  }

  /**
   * Sends the seek's time to picture once the element shows it: it has stopped seeking, holds the picture at
   * its clock, and is past the target; a playing element must also have shown a frame since the seek began
   * (a paused one shows the frame it seeked to, and no more). To be called on the element's events and ticks.
   */
  check(): void {
    const pending = this.#pending
    if (pending === null) return
    const video = this.#video
    if (video.seeking || video.readyState < HAVE_CURRENT_DATA) return
    if (video.currentTime < pending.to - 0.05) return
    const frames = framesShown(video)
    // A lower count is a new element (a reopen): the new baseline, as in the watchdog.
    if (frames < pending.frames) pending.frames = frames
    // A hidden page shows no new frames, though it plays.
    if (!video.paused && !document.hidden && frames <= pending.frames) return
    this.#pending = null
    this.#say({
      type: 'seek',
      to: pending.to,
      inWindow: pending.inWindow,
      ms: Math.max(0, Math.round(this.#now() - pending.startedAt)),
    })
  }

  /** The target of a seek that has no picture by its deadline, once; null otherwise. */
  overdue(): number | null {
    const pending = this.#pending
    if (pending === null || pending.late || this.#now() - pending.startedAt < SEEK_DEADLINE_MS) {
      return null
    }
    pending.late = true
    return pending.to
  }
}
