// What the browser suites of the engine share (DESIGN.md §10.4): a play of a named synthetic file through
// `playStreamed`, with its events and numbers kept, a wait that fails when the play ends, and the checks on
// the private file system. Each suite that begins plays runs `endPlays` after each test.

import type { TimelineEventInput } from '@dfs/shared'
import { describe } from 'vitest'
import { STUCK_MS, WATCH_EVERY_MS } from '../limits.ts'
import { PLAYS_DIRECTORY } from '../opfs.ts'
import { playStreamed } from '../page/index.ts'
import type { EngineStats } from '../page/index.ts'
import { silentFreezes } from '../testing/freeze.ts'
import type { Stamped, WaitSpan } from '../testing/freeze.ts'
import { control, fileUrl, files } from './server.ts'

export const synthetic = files().filter((file) => file.synthetic)

/** The served synthetic file of that name, if the corpus was made. */
export function served(name: string): (typeof synthetic)[number] | undefined {
  return synthetic.find((file) => file.name === name || file.name.endsWith(`/${name}`))
}

export function suite(name: string): ReturnType<typeof describe.skipIf> {
  return describe.skipIf(served(name) === undefined)
}

/** A worker that serves the store, as the app's own will. */
function makeWorker(): Worker {
  return new Worker(new URL('./store-worker.ts', import.meta.url), { type: 'module' })
}

/** Room enough for the disk store, whatever the machine has. */
const roomy = (): Promise<{ quota: number; usage: number }> =>
  Promise.resolve({ quota: 10 * 1024 ** 3, usage: 0 })

export interface Play {
  video: HTMLVideoElement
  playId: string
  events: TimelineEventInput[]
  /** The events again, each with when it was seen: milliseconds after the play began (`startedAt`), on `performance.now()`'s clock. */
  stamped: Stamped[]
  /** The element's `waiting` stretches, on the same clock: one is open (`to` null) while the element waits. */
  waits: WaitSpan[]
  /** `performance.now()` when the play began. */
  startedAt: number
  stats: EngineStats[]
  controller: AbortController
  /** What the engine's promise gave: pending until the play ends. */
  done: Promise<void>
  /** Set once the promise rejects. */
  rejection: { reason: unknown } | null
  /** Set once the promise resolves. */
  resolved: boolean
}

const plays: Play[] = []

export const frames = (video: HTMLVideoElement): number =>
  video.getVideoPlaybackQuality().totalVideoFrames

/** Resets the network, ends every play that was begun and waits for the engine to finish closing. */
export async function endPlays(): Promise<void> {
  await control({})
  for (const play of plays.splice(0)) {
    play.controller.abort(new Error('the test is over'))
    await play.done.catch(() => undefined)
    play.video.remove()
  }
}

/** The element's own sense of waiting: it begins at `waiting`, and ends when the element can play again, plays, pauses or ends. */
function watchWaits(play: Play): void {
  const now = (): number => performance.now() - play.startedAt
  play.video.addEventListener('waiting', () => {
    // None yet, or the last one is over: a new one begins. One that is open goes on.
    if (play.waits.at(-1)?.to !== null) play.waits.push({ from: now(), to: null })
  })
  for (const name of ['playing', 'canplay', 'ended', 'emptied', 'pause']) {
    play.video.addEventListener(name, () => {
      const last = play.waits.at(-1)
      if (last?.to === null) last.to = now()
    })
  }
}

/** The plays that were begun and not yet ended. */
export function activePlays(): readonly Play[] {
  return plays
}

/** The waits of a play that the engine left in silence (src/testing/freeze.ts), judged as of now. */
export function silentWaits(play: Play): WaitSpan[] {
  // The watchdog's first act can come STUCK_MS plus a tick after the clock stops: that is the longest silent piece.
  return silentFreezes(
    play.waits,
    play.stamped,
    performance.now() - play.startedAt,
    STUCK_MS + WATCH_EVERY_MS,
  )
}

/** Starts a play of the named file, with its events and numbers kept. The engine's promise is not awaited. */
export function begin(
  name: string,
  options: {
    startAt?: number
    windowBytes?: number
    autoplay?: () => boolean
    /** Plays with the memory store (no worker), as where the private file system is unavailable. */
    memory?: boolean
    onEvent?: (event: TimelineEventInput, play: Play) => void
  } = {},
): Play {
  // Any file of the corpus plays, the user's included (read in place by the server); `served` is the synthetic ones only.
  const file = files().find(
    (candidate) => candidate.name === name || candidate.name.endsWith(`/${name}`),
  )
  if (file === undefined) throw new Error(`${name} is not served.`)
  const video = document.createElement('video')
  video.muted = true
  document.body.append(video)
  const controller = new AbortController()
  const startedAt = performance.now()
  const events: TimelineEventInput[] = []
  const stamped: Stamped[] = []
  const stats: EngineStats[] = []
  const playId = crypto.randomUUID()
  // eslint-disable-next-line prefer-const -- the event hook reads `play`, so it is declared before the call that makes the hook run.
  let play: Play
  const done = playStreamed({
    video,
    url: fileUrl(file.id),
    playId,
    makeWorker: options.memory === true ? null : makeWorker,
    signal: controller.signal,
    ...(options.startAt === undefined ? {} : { startAt: options.startAt }),
    ...(options.windowBytes === undefined ? {} : { windowBytes: options.windowBytes }),
    ...(options.autoplay === undefined ? {} : { autoplay: options.autoplay }),
    onEvent: (event) => {
      events.push(event)
      stamped.push({ at: performance.now() - startedAt, event })
      options.onEvent?.(event, play)
    },
    onStats: (numbers) => stats.push(numbers),
    estimate: roomy,
  })
  play = {
    video,
    playId,
    events,
    stamped,
    waits: [],
    startedAt,
    stats,
    controller,
    done,
    rejection: null,
    resolved: false,
  }
  watchWaits(play)
  done.then(
    () => {
      play.resolved = true
    },
    (reason: unknown) => {
      play.rejection = { reason }
    },
  )
  plays.push(play)
  return play
}

/** Waits until `done` holds; a play whose promise rejected or resolved meanwhile fails the wait. */
export async function until(
  play: Play,
  what: string,
  ms: number,
  done: () => boolean,
): Promise<void> {
  const from = performance.now()
  while (!done()) {
    if (play.resolved) throw new Error(`The play ended while waiting for ${what}.`)
    if (play.rejection !== null) {
      throw new Error(`The play was rejected while waiting for ${what}.`, {
        cause: play.rejection.reason,
      })
    }
    if (performance.now() - from > ms) throw new Error(`Gave up waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

export function ofType<T extends TimelineEventInput['type']>(
  events: readonly TimelineEventInput[],
  type: T,
): Extract<TimelineEventInput, { type: T }>[] {
  return events.filter((event): event is Extract<TimelineEventInput, { type: T }> => {
    return event.type === type
  })
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'NotFoundError'
}

/** Whether the directory of a play is in the private file system. */
export async function directoryExists(playId: string): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle(PLAYS_DIRECTORY)
    await directory.getDirectoryHandle(playId)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}
