// The hold for the network (DESIGN.md §10.4; the iron-clad spec §4.8): when the play may start, or start again
// after a seek or a stall, and when it waits. The rule is `holdDecision`, which measures what the STORE holds
// ahead of the playhead, never the decoder window, so a window shrunk by quota errors cannot hold a play for
// ever. The hold is the engine's own pause: while it holds, the element is paused, and when the rule lets go
// the engine calls `play()`. Only a play that has an `autoplay` is held or played by the engine at all; with
// none, the element is the viewer's. Only a wanted play is held: a seek made while paused never holds or plays.
// Nothing here feeds, and no timer runs: the play asks it to check on its tick.

import type { TimelineEventInput } from '@dfs/shared'
import type { Downloader } from '../downloader.ts'
import type { Feeder } from '../engine/feeder.ts'
import { holdDecision } from '../engine/hold.ts'
import type { HoldDecision, HoldReason } from '../engine/hold.ts'
import type { RangeSet } from '../ranges.ts'

/** What the play lets the hold read and say. */
export interface HoldWorld {
  video: HTMLVideoElement
  /** Whether the engine should be playing now, read each time it would start or resume play; missing is never. */
  autoplay: (() => boolean) | undefined
  downloader: () => Downloader | null
  feeder: () => Feeder | null
  /** True once the feed answered `'ended'`: every fragment is appended, and the hold is not consulted. */
  feedDone: () => boolean
  say: (event: TimelineEventInput) => void
  /** The numbers the hold keeps: whether it holds, how many holds ended, and for how long. */
  stats: { holding: boolean; holds: number; holdMs: number }
  /** Called when the numbers changed. */
  changed: () => void
  now: () => number
}

/** The bytes of `held` before `offset`. */
function heldBefore(held: RangeSet, offset: number): number {
  let total = 0
  for (const range of held.ranges()) total += Math.max(0, Math.min(range.end, offset) - range.start)
  return total
}

/** The seconds the clock must have moved from where it started before a wait is a stall. */
const STALL_AFTER_SECONDS = 0.1

export class Holding {
  readonly #world: HoldWorld
  #holding = false
  #reason: HoldReason = 'start'
  #since = 0
  /** Whether the hold has paused the element: its `pause` event is then the hold's, not the viewer's. */
  #pausedByHold = false
  /** Where the clock was when the play started, resumed or was moved: a `waiting` before the clock has moved is the start's wait for its first frames, not a stall. */
  #anchor = 0
  /** What the rule last measured, which the `hold` events tell: the store's seconds ahead of the playhead, and the goal. */
  #aheadSeconds = 0
  #goalSeconds = 0

  constructor(world: HoldWorld) {
    this.#world = world
  }

  /** The clock was put elsewhere (a seek): a stall is the next wait after it has moved from there. */
  moved(): void {
    this.#anchor = this.#world.video.currentTime
  }

  get holding(): boolean {
    return this.#holding
  }

  /** True while a hold for a wanted play is on: a play that is not wanted is never held. */
  get wantsPlay(): boolean {
    return this.#holding
  }

  /**
   * The rule's answer for the playhead now, or null when there is nothing to wait for: the duration is not
   * known (play as soon as the common start is set), the feed has ended (at the end the hold is not consulted),
   * the download is done or has failed (nothing more will come, so waiting gains nothing), or the store holds
   * every byte from the playhead's offset to the end of the file.
   */
  #decide(reason: HoldReason): HoldDecision | null {
    const { video } = this.#world
    const downloader = this.#world.downloader()
    const feeder = this.#world.feeder()
    if (downloader === null || feeder === null || this.#world.feedDone()) return null
    const state = downloader.state()
    if (state === 'done' || state === 'failed') return null
    const duration = feeder.durationSeconds
    if (duration === null || !(duration > 0)) return null
    const bitrate = downloader.fileSize / duration
    if (!(bitrate > 0)) return null
    const at = video.currentTime
    const offset = feeder.positions.offsetAt(at)
    const { store } = downloader
    const held = store.held()
    const ahead = offset === null ? 0 : held.heldFrom(offset)
    if (offset !== null && ahead >= downloader.fileSize - offset) return null
    const behind = offset === null ? 0 : heldBefore(held, offset)
    const decision = holdDecision({
      reason,
      heldAheadSeconds: ahead / bitrate,
      rateBytesPerSecond: state === 'reading' ? downloader.rate() : null,
      bitrateBytesPerSecond: bitrate,
      remainingSeconds: duration - at,
      storeAheadCapSeconds: (store.capBytes - Math.min(behind, store.capBytes / 2)) / bitrate,
      storeFull: state === 'full',
    })
    this.#aheadSeconds = ahead / bitrate
    this.#goalSeconds = decision.goalSeconds
    return decision
  }

  /**
   * The play starts (`start`: wanted when `autoplay()` says so) or a seek ends (`seek`: wanted when the play
   * was playing, `playing`): holds while the rule says to wait, else plays. A play that is not wanted is never
   * held, and a hold that is on is left with no play. Does nothing for a play with no `autoplay`.
   */
  begin(reason: 'start' | 'seek', playing = true): void {
    const { autoplay } = this.#world
    if (autoplay === undefined) return
    this.moved()
    const wanted = reason === 'start' ? autoplay() : playing
    if (!wanted) {
      if (this.#holding) this.#leave()
      return
    }
    if (this.#holding) this.#reason = reason
    if (this.#decide(reason)?.hold === true) {
      if (!this.#holding) this.#enter(reason)
      return
    }
    if (this.#holding) this.#leave()
    this.#play()
  }

  /** The element stalled (`waiting`) while playing: a wanted play, so it holds, and pauses, when the rule says to wait. */
  stalled(): void {
    const { video } = this.#world
    if (this.#world.autoplay === undefined || this.#holding) return
    if (video.paused || video.ended || video.seeking) return
    if (Math.abs(video.currentTime - this.#anchor) < STALL_AFTER_SECONDS) return
    if (this.#decide('stall')?.hold === true) this.#enter('stall')
  }

  /** To be called on the tick: lets the hold go, and plays, when the rule no longer says to wait. */
  check(): void {
    if (!this.#holding) return
    if (this.#decide(this.#reason)?.hold === true) return
    this.#leave()
    this.#play()
  }

  /** The element's `pause` event: the viewer's pause during a hold ends the hold with no play. */
  paused(): void {
    if (this.#pausedByHold) {
      this.#pausedByHold = false
      return
    }
    if (this.#holding) this.#leave()
  }

  /** The element's `play` event: the viewer's play during a hold ends it (the engine's own play comes after the hold is left). */
  played(): void {
    if (this.#holding) this.#leave()
  }

  #enter(reason: HoldReason): void {
    const world = this.#world
    this.#holding = true
    this.#reason = reason
    this.#since = world.now()
    world.stats.holding = true
    if (!world.video.paused) {
      this.#pausedByHold = true
      world.video.pause()
    }
    this.#report(true)
    world.changed()
  }

  #leave(): void {
    const world = this.#world
    this.#holding = false
    world.stats.holding = false
    world.stats.holds += 1
    world.stats.holdMs += world.now() - this.#since
    this.#report(false)
    world.changed()
  }

  /** Plays a wanted play, unless `autoplay()` now says no (a slide swiped away during a hold); a refusal of the browser is not the play's failure. */
  #play(): void {
    const { video, autoplay } = this.#world
    if (autoplay?.() === false || !video.paused) return
    this.moved()
    video.play().catch(() => undefined)
  }

  #report(on: boolean): void {
    this.#world.say({
      type: 'hold',
      on,
      reason: on ? this.#reason : null,
      aheadS: Number.isFinite(this.#aheadSeconds) ? this.#aheadSeconds : 0,
      targetS: Number.isFinite(this.#goalSeconds) ? this.#goalSeconds : 0,
    })
  }
}
