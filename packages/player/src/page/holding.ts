// The hold for the network (DESIGN.md §10.4; the iron-clad spec §4.8): when the play may start, or start again
// after a seek or a stall, and when it waits. The rule is `holdDecision`, which measures what is held ahead of the
// playhead: for a start and a seek the larger of what the STORE holds and what the element has buffered there (a stall
// is measured on the store alone: its goal is a byte budget from the file's average bit rate). The window is never what
// a hold waits to fill (the goal is measured, not the window's reach), and taking the larger can only shorten a
// hold, so a window shrunk by quota errors cannot hold a play for ever, and a seek the decoder already covers is
// not held for want of stored bytes (blocks evicted behind the position, a fresh memory store).
// The hold is the engine's own pause: while it holds, the element is paused, and when the rule lets go the engine
// calls `play()`. Only a play that has an `autoplay` is held or played by the engine at all; with
// none, the element is the viewer's. Only a wanted play is held: a seek made while paused never holds or plays.
// Nothing here feeds. The play asks it to check on its tick, and while a hold is on a timer of its own checks too
// (`HOLD_CHECK_MS`): when the engine says it can (`canCheck`: not busy, not stopped, not failed), and also when the
// viewer's "no" is in (`autoplay()` false) while the play is alive, even busy: the hold then leaves at once with no
// play, so a pause is not counted as waiting. `dispose` stops it.
// A viewer's "no" leaves a standing goal (a hold the viewer ended, a seek or start that was not wanted): a Play at the
// same place re-asks the rule, so it waits for the goal like a play that was wanted from the start.

import type { TimelineEventInput } from '@dfs/shared'
import type { Downloader } from '../downloader.ts'
import type { Feeder } from '../engine/feeder.ts'
import { KEEPS_UP, holdDecision } from '../engine/hold.ts'
import type { HoldDecision, HoldReason } from '../engine/hold.ts'
import { HOLD_CHECK_MS, WINDOW_AHEAD_SECONDS } from '../limits.ts'
import type { RangeSet } from '../ranges.ts'
import { aheadOf } from './video.ts'

/** What the play lets the hold read and say. */
export interface HoldWorld {
  video: HTMLVideoElement
  /** Whether the engine should be playing now, read each time it would start or resume play; missing is never. */
  autoplay: (() => boolean) | undefined
  downloader: () => Downloader | null
  feeder: () => Feeder | null
  /** True once the feed answered `'ended'`: every fragment is appended, and the hold is not consulted. */
  feedDone: () => boolean
  /** The decoder window's byte limit now (it shrinks on quota errors). */
  windowLimitBytes: () => number
  /** Whether the engine can be checked for a release now: it is not busy with a request, and the play is neither stopped nor failed. The hold's own timer asks it. */
  canCheck: () => boolean
  /** Whether the play is alive: neither stopped nor failed. The timer does nothing once it is not, and lets a hold go on the viewer's "no" while alive even when the engine is busy. */
  alive: () => boolean
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

/** How far from where a standing goal was set the clock may be for a play to still be the viewer's play at that place: a frame or two, not a seek. */
const STANDING_PLACE_SECONDS = 0.25

/**
 * The rate the hold rule is given. While the downloader reads it is the measured rate. While it waits (a retry
 * pause) the meter still holds the rate from before the link dropped, so only a slow one is trusted, which can
 * only lengthen the hold; a rate that keeps up is not given, so a hold is not let go into an outage (§10.4).
 */
function heldRate(state: string, rate: number | null, bitrate: number): number | null {
  if (state === 'reading') return rate
  if (state === 'waiting' && rate !== null && rate < bitrate * KEEPS_UP) return rate
  return null
}

export class Holding {
  readonly #world: HoldWorld
  #holding = false
  #reason: HoldReason = 'start'
  #since = 0
  /** How many `pause()` calls the hold has made whose `pause` event has not been seen: each such event is the hold's, not the viewer's (several can be queued before the first dispatches). Assumes each pause yields a `pause` event: a media load (a reopen's `src` change) can drop a queued one, which would leave the count one high and swallow a later real pause during a hold; no realistic trigger was found (the watchdog is silent while a hold is on). */
  #ownPauses = 0
  /**
   * The goal a viewer's "no" left standing: a hold left by the viewer's pause (or by `autoplay()` turning to no), or a
   * seek or a start that was not wanted, did not wait for what the rule asks. A Play at the same place re-asks the
   * rule, so it waits for the goal as a play that was wanted all along (`played()`). Cleared by a viewer's seek
   * (`moved()`), by a hold that is entered, and once used.
   */
  #standing: { reason: HoldReason; at: number } | null = null
  /** Where the clock was when the play started, resumed or was moved: a `waiting` before the clock has moved is the start's wait for its first frames, not a stall. */
  #anchor = 0
  /** What the rule last measured, which the `hold` events tell: the store's seconds ahead of the playhead, and the goal. */
  #aheadSeconds = 0
  #goalSeconds = 0
  /** The check that runs every HOLD_CHECK_MS while a hold is on, and only then. */
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(world: HoldWorld) {
    this.#world = world
  }

  /**
   * The clock was put elsewhere (a seek): a stall is the next wait after it has moved from there, and a standing goal
   * is over. The engine's own seek (`keepGoal`: the common start, a window start, a reopen's deferred seek) moves the
   * anchor only: it follows the decision that set the goal, and is not the viewer's.
   */
  moved(keepGoal = false): void {
    this.#anchor = this.#world.video.currentTime
    if (!keepGoal) this.#standing = null
  }

  /** Forgets the standing goal: the engine is about to play by itself, which no goal may re-hold. */
  dropGoal(): void {
    this.#standing = null
  }

  #stand(reason: HoldReason): void {
    this.#standing = { reason, at: this.#world.video.currentTime }
  }

  get holding(): boolean {
    return this.#holding
  }

  /** True while a hold for a wanted play is on: a play that is not wanted is never held, and one whose `autoplay()` now says no is not wanted. */
  get wantsPlay(): boolean {
    return this.#holding && this.#world.autoplay?.() !== false
  }

  /**
   * The rule's answer for the playhead now, or null when there is nothing to wait for: the duration is not
   * known (play as soon as the common start is set), the feed has ended (at the end the hold is not consulted),
   * the download is done or has failed (nothing more will come, so waiting gains nothing), or the store holds
   * every byte from the playhead's offset to the end of the file.
   */
  #decide(reason: HoldReason, seek?: { at: number; offset: number | null }): HoldDecision | null {
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
    const at = seek === undefined ? video.currentTime : seek.at
    const offset = seek === undefined ? feeder.positions.offsetAt(at) : seek.offset
    const { store } = downloader
    const held = store.held()
    const ahead = offset === null ? 0 : held.heldFrom(offset)
    if (offset !== null && ahead >= downloader.fileSize - offset) return null
    const behind = offset === null ? 0 : heldBefore(held, offset)
    // The store's seconds ahead, or the element's from the same time when that is more: a seek's pre-hold measures at its target, where the emptied sink holds nothing. Not for a stall: its goal is a byte budget from the file's average bit rate, so it stays measured on the store (decoded seconds of a thin stretch would release it early).
    const storeSeconds = ahead / bitrate
    const heldAheadSeconds =
      reason === 'stall' ? storeSeconds : Math.max(storeSeconds, aheadOf(video.buffered, at))
    const decision = holdDecision({
      reason,
      heldAheadSeconds,
      rateBytesPerSecond: heldRate(state, downloader.rate(), bitrate),
      bitrateBytesPerSecond: bitrate,
      remainingSeconds: duration - at,
      storeAheadCapSeconds: (store.capBytes - Math.min(behind, store.capBytes / 2)) / bitrate,
      windowAheadCapSeconds: Math.min(
        WINDOW_AHEAD_SECONDS,
        this.#world.windowLimitBytes() / bitrate,
      ),
      storeFull: state === 'full',
      // A hold relabelled to `seek` keeps its `#since`; only a stall reads this. Before a hold is on there is nothing waited.
      waitedSeconds: this.#holding ? (this.#world.now() - this.#since) / 1000 : 0,
    })
    this.#aheadSeconds = heldAheadSeconds
    this.#goalSeconds = decision.goalSeconds
    return decision
  }

  /**
   * The play starts (`start`: wanted when `autoplay()` says so) or a seek ends (`seek`: wanted when the play
   * was playing, `playing`, and `autoplay()` still says yes): holds while the rule says to wait, else plays. A play that is not wanted is never
   * held, and a hold that is on is left with no play. Does nothing for a play with no `autoplay`.
   */
  begin(reason: 'start' | 'seek', playing = true): void {
    const { autoplay } = this.#world
    if (autoplay === undefined) return
    this.moved()
    const wanted = reason === 'start' ? autoplay() : playing && autoplay()
    if (!wanted) {
      if (this.#holding) this.#leave()
      // Not wanted now: a Play at this place waits for the goal then (`played()`).
      this.#stand(reason)
      return
    }
    if (this.#holding) this.#reason = reason
    if (this.#decide(reason)?.hold === true) {
      if (!this.#holding) this.#enter(reason)
      // A hold always means a paused element: a play from outside during it is paused back.
      else this.#pauseForHold()
      return
    }
    if (this.#holding) this.#leave()
    this.#play()
  }

  /**
   * A viewer's seek outside the decoder window is being served: its target is `to`, its feed about to start from
   * the file offset `offset` (the feeder's: the positions still hold the old runs, so they are not asked; null
   * when there is no next read, so nothing to wait for), with the sink empty. A seek that is not wanted
   * (`playing`, and `autoplay()`) leaves a hold that is on, with no play, as `begin` does. A wanted one, on a
   * link that does not keep up (the rule's goal over 0), holds now, at the seek, whatever the store holds: the
   * store's state is the old position's, and the serve's end (`begin('seek')`) measures with the fed positions
   * and lets go at once when the goal is already stored, so nothing plays from the first appended fragments
   * before the goal. A link that keeps up (goal 0) is not held here: it plays at the first frames, with no
   * pause and play between. A hold already on stays, its reason becoming `seek`. Does nothing for a play with no `autoplay`.
   */
  seekStarted(playing: boolean, to: number, offset: number | null): void {
    const { autoplay } = this.#world
    if (autoplay === undefined) return
    this.moved()
    if (!(playing && autoplay())) {
      if (this.#holding) this.#leave()
      return
    }
    const decision = offset === null ? null : this.#decide('seek', { at: to, offset })
    if (decision === null || !(decision.goalSeconds > 0)) {
      // Nothing to wait for: a hold that is on while the element plays (the viewer's play) is over, and the element already plays.
      if (this.#holding && !this.#world.video.paused) this.#leave()
      return
    }
    if (this.#holding) {
      this.#reason = 'seek'
      // A play from outside (Picture-in-Picture's button) during the hold: the hold pauses it back, as its own pause.
      this.#pauseForHold()
    } else this.#enter('seek')
  }

  /** The element stalled (`waiting`) while playing: a wanted play, so it holds, and pauses, when the rule says to wait. */
  stalled(): void {
    const { video } = this.#world
    if (this.#world.autoplay === undefined || this.#holding) return
    if (video.paused || video.ended || video.seeking) return
    if (Math.abs(video.currentTime - this.#anchor) < STALL_AFTER_SECONDS) return
    if (this.#decide('stall')?.hold === true) this.#enter('stall')
  }

  /**
   * To be called on the tick: lets the hold go, and plays, when the rule no longer says to wait. A hold whose
   * `autoplay()` now says no is left with no play: the element is paused by the hold, so the viewer's pause is
   * a no-op that sends no `pause` event, and `autoplay()` is how the hold learns of it.
   */
  check(): void {
    if (!this.#holding) return
    if (this.#world.autoplay?.() === false) {
      this.#stand(this.#reason)
      this.#leave()
      return
    }
    if (this.#decide(this.#reason)?.hold === true) return
    this.#leave()
    this.#play()
  }

  /**
   * The element's `pause` event: the viewer's pause during a hold ends the hold with no play. One event for each
   * pause the hold made is the hold's own; an event for an element that plays at dispatch is stale (the pause was
   * undone, by a play), and ends nothing.
   */
  paused(): void {
    if (this.#ownPauses > 0) {
      this.#ownPauses -= 1
      return
    }
    if (!this.#world.video.paused) return
    if (this.#holding) {
      this.#stand(this.#reason)
      this.#leave()
    }
  }

  /**
   * The element's `play` event: the viewer's play during a hold ends it (the engine's own play comes after the hold is
   * left). An event for an element that is paused at dispatch is stale (the play was undone, by the hold's own pause or
   * the viewer's): it ends nothing. With no hold on, a standing goal at this place is used up and asked of the rule again:
   * on a link that does not keep up the play is held, the element paused back as the hold's own pause. While the engine
   * cannot check (a serve runs) it holds at once and the timer's check decides later.
   */
  played(): void {
    const { video } = this.#world
    if (video.paused) return
    if (this.#holding) {
      this.#leave()
      return
    }
    const standing = this.#standing
    if (standing === null) return
    // Used up at this play, whatever comes of it.
    this.#standing = null
    // A play the intent does not back, one away from the goal's place, or one of a play that is over, is not the goal's.
    if (this.#world.autoplay?.() !== true || !this.#world.alive()) return
    if (Math.abs(video.currentTime - standing.at) > STANDING_PLACE_SECONDS) return
    // While the engine cannot check (a refeed or a reopen is served or queued: `#decide` would read stale numbers) the goal holds now, with no decision: the hold's timer decides once the engine can, and lets go at once on a link that keeps up. The hold's event then carries the last numbers measured.
    if (!this.#world.canCheck() || this.#decide(standing.reason)?.hold === true) {
      this.#enter(standing.reason)
    }
  }

  /** Stops the check of a hold that is on: the play is over. */
  dispose(): void {
    this.#stopTimer()
  }

  #stopTimer(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  #enter(reason: HoldReason): void {
    const world = this.#world
    this.#holding = true
    this.#standing = null
    this.#timer ??= setInterval(() => {
      if (!this.#world.alive()) return
      // The viewer's "no" is checked even while busy: `check()` leaves with no play then, and decides nothing.
      if (this.#world.canCheck() || this.#world.autoplay?.() === false) this.check()
    }, HOLD_CHECK_MS)
    this.#reason = reason
    this.#since = world.now()
    world.stats.holding = true
    this.#pauseForHold()
    this.#report(true)
    world.changed()
  }

  /** Pauses a playing element as the hold's own pause: its `pause` event is the hold's, not the viewer's. */
  #pauseForHold(): void {
    const { video } = this.#world
    if (video.paused) return
    this.#ownPauses += 1
    video.pause()
  }

  #leave(): void {
    const world = this.#world
    this.#stopTimer()
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
