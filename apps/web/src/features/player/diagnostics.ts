import {
  deliverySchema,
  type Delivery,
  type MediaInfo,
  type MediaStream,
  type PlaybackReport,
} from '@dfs/shared'
import { queryOptions } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { apiFetch, apiGet } from '@/lib/api/client'
import { describeBriefly, mimeTypeOf, playedStreams } from './codecs'

// Why a video is slow (DESIGN.md §10.4, §16), as the player can tell: whether
// this device decodes it smoothly (Media Capabilities), how fast it arrives
// while the player waits, and how many frames the browser drops. The player
// warns of each, and reports how the play went to the API when it ends.

/** What the browser says of decoding a video. */
export interface Decoding {
  supported: boolean
  smooth: boolean
  /** Usually: in hardware. */
  powerEfficient: boolean
}

/** What to ask the browser of a video: its picture's codec, size, frame rate, bitrate and HDR. */
export function decodingConfiguration(info: MediaInfo): MediaDecodingConfiguration | null {
  const { video } = playedStreams(info)
  const contentType = video && mimeTypeOf(video)
  if (!video?.width || !video.height || !contentType) return null
  return {
    type: 'file',
    video: {
      contentType,
      width: video.width,
      height: video.height,
      bitrate: Math.max(1, info.bitRate ?? 1),
      framerate: video.frameRate ?? 30,
      ...(video.hdr && { transferFunction: video.hdr }),
    },
  }
}

/** The browser's answer for this version, once its media info is known; `null` where it can't say. */
export function decodingQuery(base: string, versionId: string | null, info: MediaInfo | null) {
  const configuration = info && decodingConfiguration(info)
  return queryOptions({
    queryKey: ['player', base, 'decoding', versionId],
    enabled: configuration !== null,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async (): Promise<Decoding | null> => {
      if (!configuration || typeof navigator === 'undefined' || !('mediaCapabilities' in navigator))
        return null
      try {
        const { supported, smooth, powerEfficient } =
          await navigator.mediaCapabilities.decodingInfo(configuration)
        return { supported, smooth, powerEfficient }
      } catch {
        return null
      }
    },
  })
}

/** What the player shows of a play going badly, updated each second. */
export interface PlaybackSignals {
  /** How long it has been waiting for data now, its first frame included; 0 while it isn't. */
  waitingForMs: number
  /** How fast the server sent the video over the last seconds of waiting, in bits a second. */
  arrivalBitsPerSecond: number | null
  /**
   * What the server waited on meanwhile: this device's connection to take
   * what it had sent, or storage (the cache, staging or Discord) to read it.
   */
  waitingOn: 'connection' | 'storage' | null
  /** The share of frames dropped over the last 10 s of playing. */
  droppedShare: number | null
}

/** What the report needs that changes as the play goes. */
interface PlaybackFacts {
  /** What the video needs, in bits a second, from its media info. */
  bitRate: number | null
  decoding: Decoding | null
  /** Why it can't play, when it can't. */
  problem: string | null
}

const SAMPLE_MS = 1000
/** While it waits, the server is asked how its reads go every this many samples. */
const ASK_EVERY = 2
/** Asks the arrival rate is read over: about the last 6 s. */
const ARRIVAL_WINDOW = 3
/** Seconds of playing dropped frames are read over. */
const FRAMES_WINDOW = 10
/** Waiting on one side more than this share of the time, the server waits on it. */
const WAITING_ON_SHARE = 0.6

const IDLE: PlaybackSignals = {
  waitingForMs: 0,
  arrivalBitsPerSecond: null,
  waitingOn: null,
  droppedShare: null,
}

/** What the server sent between two asks while the player waited. */
interface Arrival {
  ms: number
  bytes: number
  sourceMs: number
  clientMs: number
}

/**
 * Follows a play as it goes, for the player's warnings, and reports it to
 * the API once, when the player closes, moves on, or the page is hidden.
 */
export function usePlaybackStats(
  video: HTMLVideoElement | null,
  /** The file's path: `/files/:id`. */
  base: string,
  versionId: string | null,
  facts: PlaybackFacts,
  /** `false` once the viewer starts closing: the report goes then, not when it has faded. */
  active: boolean,
): PlaybackSignals {
  const [signals, setSignals] = useState<PlaybackSignals>(IDLE)
  const latest = useRef(facts)
  useEffect(() => {
    latest.current = facts
  })
  /** The running play's report, for sending early. */
  const sendReport = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!active) sendReport.current?.()
  }, [active])

  useEffect(() => {
    if (!video || !versionId) return
    const now = () => performance.now()
    const startedAt = now()
    let firstFrameAt: number | null = null
    /** When it first played: its first frame may come long before. */
    let playingAt: number | null = null
    /**
     * Since when it waits for data, as the viewer sees it: before its first
     * frame, or playing but without the data to go on (a stall or a seek).
     */
    let starvingSince: number | null = startedAt
    let stalls = 0
    let stallMs = 0
    let stallSince: number | null = null
    let seeks = 0
    let seekWaitMs = 0
    let seekSince: number | null = null
    let starvedBytes = 0
    let starvedMs = 0
    let arrivals: Arrival[] = []
    /** The server's totals at the last ask, and when the answer came. */
    let lastAsk: { at: number; totals: Delivery } | null = null
    let asking = false
    let samples = 0
    let frames: { total: number; dropped: number }[] = []
    let reported = false

    // The server counts the bytes the video element can't (§10.4): its
    // reads of this version for this user, summed, as they go.
    const ask = async () => {
      if (asking) return
      asking = true
      try {
        const totals = await apiGet(`${base}/media/${versionId}/delivery`, deliverySchema)
        const at = now()
        const before = lastAsk
        lastAsk = { at, totals }
        if (!before || starvingSince === null) return
        const arrival: Arrival = {
          ms: at - before.at,
          bytes: totals.bytes - before.totals.bytes,
          sourceMs: totals.waitedForSourceMs - before.totals.waitedForSourceMs,
          clientMs: totals.waitedForClientMs - before.totals.waitedForClientMs,
        }
        // Totals go back only when the server forgot them: no reading then.
        if (arrival.bytes < 0 || arrival.ms <= 0) return
        starvedBytes += arrival.bytes
        starvedMs += arrival.ms
        arrivals = [...arrivals, arrival].slice(-ARRIVAL_WINDOW)
      } catch {
        // Not now: the next ask.
      } finally {
        asking = false
      }
    }

    // What the element did before this was listening: a video the browser
    // had loaded can show its first frame, or play, at once.
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) firstFrameAt = startedAt
    if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      playingAt = startedAt
    }

    const onFirstFrame = () => {
      firstFrameAt ??= now()
    }
    const onPlaying = () => {
      const at = now()
      playingAt ??= at
      if (stallSince !== null) {
        stalls += 1
        stallMs += at - stallSince
        stallSince = null
      }
    }
    const onWaiting = () => {
      // Once it has played, a wait that isn't a seek's is a stall.
      if (playingAt !== null && !video.seeking) stallSince ??= now()
    }
    const onSeeking = () => {
      seekSince ??= now()
    }
    const onSeeked = () => {
      if (seekSince === null) return
      seeks += 1
      seekWaitMs += now() - seekSince
      seekSince = null
    }

    const sample = () => {
      const at = now()
      samples += 1
      const starving =
        firstFrameAt === null ||
        (!video.paused && !video.ended && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
      if (!starving) {
        // The next wait starts its own readings.
        starvingSince = null
        arrivals = []
        lastAsk = null
      } else {
        starvingSince ??= at
        if (samples % ASK_EVERY === 0) void ask()
      }
      const quality = video.getVideoPlaybackQuality()
      if (!video.paused) {
        frames = [
          ...frames,
          { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames },
        ].slice(-FRAMES_WINDOW)
      }
      const first = frames[0]
      const newest = frames.at(-1)
      const shown = first && newest ? newest.total - first.total : 0
      const sum = (pick: (arrival: Arrival) => number) =>
        arrivals.reduce((total, arrival) => total + pick(arrival), 0)
      const arrivedMs = sum((arrival) => arrival.ms)
      const waited = sum((arrival) => arrival.sourceMs + arrival.clientMs)
      setSignals({
        waitingForMs: starvingSince === null ? 0 : at - starvingSince,
        arrivalBitsPerSecond:
          arrivals.length >= 2 ? ((sum((arrival) => arrival.bytes) * 8) / arrivedMs) * 1000 : null,
        waitingOn:
          arrivals.length < 2 || waited === 0
            ? null
            : sum((arrival) => arrival.clientMs) / waited > WAITING_ON_SHARE
              ? 'connection'
              : sum((arrival) => arrival.sourceMs) / waited > WAITING_ON_SHARE
                ? 'storage'
                : null,
        droppedShare:
          first && newest && shown >= 30 ? (newest.dropped - first.dropped) / shown : null,
      })
    }

    const report = () => {
      if (reported) return
      reported = true
      const at = now()
      // A wait the viewer left in counts to its end.
      if (stallSince !== null) {
        stalls += 1
        stallMs += at - stallSince
      }
      if (seekSince !== null) {
        seeks += 1
        seekWaitMs += at - seekSince
      }
      const quality = video.getVideoPlaybackQuality()
      const { problem, decoding } = latest.current
      const error = video.error
        ? video.error.message || `media error ${String(video.error.code)}`
        : null
      const body: PlaybackReport = {
        versionId,
        outcome:
          firstFrameAt !== null ? 'played' : problem !== null || error !== null ? 'failed' : 'left',
        firstFrameMs: firstFrameAt === null ? null : bounded(firstFrameAt - startedAt),
        startMs: playingAt === null ? null : bounded(playingAt - startedAt),
        openMs: bounded(at - startedAt),
        stalls,
        stallMs: bounded(stallMs),
        seeks,
        seekWaitMs: bounded(seekWaitMs),
        frames: quality.totalVideoFrames,
        droppedFrames: quality.droppedVideoFrames,
        arrivalBitsPerSecond:
          starvedMs >= 2000 ? Math.round(((starvedBytes * 8) / starvedMs) * 1000) : null,
        decoding,
        problem: (problem ?? error)?.slice(0, 300) ?? null,
      }
      void apiFetch(`${base}/playback-report`, {
        method: 'POST',
        json: body,
        keepalive: true,
      }).catch(() => undefined)
    }
    sendReport.current = report
    const onHidden = () => {
      if (document.visibilityState === 'hidden') report()
    }

    video.addEventListener('loadeddata', onFirstFrame)
    video.addEventListener('playing', onPlaying)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('seeking', onSeeking)
    video.addEventListener('seeked', onSeeked)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', report)
    const timer = window.setInterval(sample, SAMPLE_MS)
    return () => {
      window.clearInterval(timer)
      video.removeEventListener('loadeddata', onFirstFrame)
      video.removeEventListener('playing', onPlaying)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('seeking', onSeeking)
      video.removeEventListener('seeked', onSeeked)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', report)
      sendReport.current = null
      report()
    }
  }, [base, versionId, video])

  return video ? signals : IDLE
}

/** Milliseconds within the report's bounds (a day). */
function bounded(ms: number): number {
  return Math.min(24 * 60 * 60 * 1000, Math.max(0, Math.round(ms)))
}

/** Bits a second as people read them: “2.7 Mbit/s”. */
export function formatBitRate(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1_000_000) {
    return `${String(Math.round(bitsPerSecond / 100_000) / 10)} Mbit/s`
  }
  return `${String(Math.round(bitsPerSecond / 1000))} kbit/s`
}

/** Waiting this long, a video arriving slower than it plays says so. */
const SLOW_AFTER_MS = 4000
/** Arriving slower than this share of what it needs is slow. */
const SLOW_SHARE = 0.9
/** Dropping more than this share of frames, a device can't keep up. */
const DROPPING_SHARE = 0.2

/** A warning above the picture: why the video may be silent, slow or stuttering. */
export interface PlaybackNotice {
  key: 'sound' | 'decoding' | 'slow' | 'dropping'
  text: string
}

/** The warnings a play deserves now, from what the browser and the play itself say. */
export function playbackNotices(input: {
  /** The sound's codec, when this browser can't decode it. */
  silentCodec: string | null
  decoding: Decoding | null
  /** The picture played. */
  picture: MediaStream | null
  /** What the video needs, in bits a second. */
  bitRate: number | null
  signals: PlaybackSignals
}): PlaybackNotice[] {
  const { silentCodec, decoding, picture, bitRate, signals } = input
  const notices: PlaybackNotice[] = []
  if (silentCodec) {
    notices.push({ key: 'sound', text: `No sound here: this browser can’t play ${silentCodec}.` })
  }
  if (decoding?.supported && !decoding.smooth && picture) {
    notices.push({
      key: 'decoding',
      text: `This device may not keep up with ${describeBriefly(picture)}: it may stutter or be slow to start.`,
    })
  }
  const arrival = signals.arrivalBitsPerSecond
  if (
    bitRate &&
    arrival !== null &&
    signals.waitingForMs > SLOW_AFTER_MS &&
    arrival < bitRate * SLOW_SHARE
  ) {
    const why =
      signals.waitingOn === 'connection'
        ? ' The server has it ready and waits on this device’s connection.'
        : signals.waitingOn === 'storage'
          ? ' The server waits on storage to read it.'
          : ''
    notices.push({
      key: 'slow',
      text: `Loading slowly: the video arrives at ${formatBitRate(arrival)} and needs ${formatBitRate(bitRate)}, so it stops to load.${why}`,
    })
  }
  if (signals.droppedShare !== null && signals.droppedShare > DROPPING_SHARE) {
    notices.push({
      key: 'dropping',
      text: `This device is dropping ${String(Math.round(signals.droppedShare * 100))}% of the frames: it can’t keep up with this video.`,
    })
  }
  return notices
}
