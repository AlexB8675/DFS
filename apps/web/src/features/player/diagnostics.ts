import type { MediaInfo, MediaStream, PlaybackReport } from '@dfs/shared'
import { queryOptions } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '@/lib/api/client'
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
  /** How fast the video arrived over the last seconds of waiting, in bits a second. */
  arrivalBitsPerSecond: number | null
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
/** Seconds of waiting the arrival rate is read over. */
const ARRIVAL_WINDOW = 5
/** Seconds of playing dropped frames are read over. */
const FRAMES_WINDOW = 10

const IDLE: PlaybackSignals = { waitingForMs: 0, arrivalBitsPerSecond: null, droppedShare: null }

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
): PlaybackSignals {
  const [signals, setSignals] = useState<PlaybackSignals>(IDLE)
  const latest = useRef(facts)
  useEffect(() => {
    latest.current = facts
  })

  useEffect(() => {
    if (!video || !versionId) return
    const now = () => performance.now()
    const startedAt = now()
    let firstFrameAt: number | null = null
    /** Since when it waits for data: from the start until its first frame, then each stall. */
    let waitingSince: number | null = startedAt
    let stalls = 0
    let stallMs = 0
    let starvedBits = 0
    let starvedMs = 0
    let last = { at: startedAt, buffered: bufferedSeconds(video) }
    let arrivals: { ms: number; bits: number }[] = []
    let frames: { total: number; dropped: number }[] = []
    let reported = false

    const onFirstFrame = () => {
      if (firstFrameAt !== null) return
      firstFrameAt = now()
      waitingSince = null
    }
    const onWaiting = () => {
      // A seek waits too, but isn't a stall.
      if (firstFrameAt !== null && !video.seeking && waitingSince === null) waitingSince = now()
    }
    const onGoing = () => {
      if (firstFrameAt === null || waitingSince === null) return
      stalls += 1
      stallMs += now() - waitingSince
      waitingSince = null
    }

    const sample = () => {
      const at = now()
      const buffered = bufferedSeconds(video)
      const ms = at - last.at
      const bits = Math.max(0, buffered - last.buffered) * (latest.current.bitRate ?? 0)
      last = { at, buffered }
      if (waitingSince !== null && latest.current.bitRate) {
        starvedBits += bits
        starvedMs += ms
        arrivals = [...arrivals, { ms, bits }].slice(-ARRIVAL_WINDOW)
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
      const arrivedMs = arrivals.reduce((sum, arrival) => sum + arrival.ms, 0)
      setSignals({
        waitingForMs: waitingSince === null ? 0 : at - waitingSince,
        arrivalBitsPerSecond:
          arrivals.length >= 3
            ? (arrivals.reduce((sum, arrival) => sum + arrival.bits, 0) / arrivedMs) * 1000
            : null,
        droppedShare:
          first && newest && shown >= 30 ? (newest.dropped - first.dropped) / shown : null,
      })
    }

    const report = () => {
      if (reported) return
      reported = true
      const at = now()
      if (firstFrameAt !== null && waitingSince !== null) {
        stalls += 1
        stallMs += at - waitingSince
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
        openMs: bounded(at - startedAt),
        stalls,
        stallMs: bounded(stallMs),
        frames: quality.totalVideoFrames,
        droppedFrames: quality.droppedVideoFrames,
        arrivalBitsPerSecond:
          starvedMs >= 2000 ? Math.round((starvedBits / starvedMs) * 1000) : null,
        decoding,
        problem: (problem ?? error)?.slice(0, 300) ?? null,
      }
      void apiFetch(`${base}/playback-report`, {
        method: 'POST',
        json: body,
        keepalive: true,
      }).catch(() => undefined)
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') report()
    }

    video.addEventListener('loadeddata', onFirstFrame)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('playing', onGoing)
    video.addEventListener('canplay', onGoing)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', report)
    const timer = window.setInterval(sample, SAMPLE_MS)
    return () => {
      window.clearInterval(timer)
      video.removeEventListener('loadeddata', onFirstFrame)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('playing', onGoing)
      video.removeEventListener('canplay', onGoing)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', report)
      report()
    }
  }, [base, versionId, video])

  return video ? signals : IDLE
}

/** Seconds of the video loaded, in all its ranges. */
function bufferedSeconds(video: HTMLVideoElement): number {
  let total = 0
  for (let i = 0; i < video.buffered.length; i += 1) {
    total += video.buffered.end(i) - video.buffered.start(i)
  }
  return total
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
    notices.push({
      key: 'slow',
      text: `Loading slowly: the video arrives at ${formatBitRate(arrival)} and needs ${formatBitRate(bitRate)}, so it stops to load.`,
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
