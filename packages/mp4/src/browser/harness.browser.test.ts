// The browser harness itself (DESIGN.md §10.4, D45): a real browser reads the
// corpus from the Range server by `inject('corpus')`, and plays a file that
// FFmpeg made through Media Source. Later suites stand on this: if it fails, they
// can't say anything about the repackager.

import { describe, expect, inject, test } from 'vitest'
import {
  appendAll,
  fetchRange,
  mediaSourceOpened,
  playsUntil,
  startsPlaying,
  waitFor,
  waitUntil,
} from './media.ts'

/** The synthetic H.264 High 720p30 with AAC, which FFmpeg wrote as a fragmented file. */
const FRAGMENTED_TYPE = 'video/mp4; codecs="avc1.64001f,mp4a.40.2"'

function fragmentedFile(): { url: string; size: number } | undefined {
  const { url, files } = inject('corpus')
  const file = files.find((entry) => entry.synthetic && entry.name.endsWith('/fragmented.mp4'))
  return file ? { url: `${url}/file/${file.id}`, size: file.size } : undefined
}

describe('serves a corpus file by Range, and plays an ffmpeg-made fragmented MP4 through Media Source', () => {
  test('gives exactly the bytes asked for, as a 206 with its Content-Range', async (ctx) => {
    const file = fragmentedFile()
    if (!file) return ctx.skip('The corpus has no fragmented.mp4 (run corpus:make).')

    const head = await fetchRange(file.url, 0, 15)
    expect(head.length).toBe(16)
    // An MP4 starts with a box header: a 32-bit size, then the type, which is `ftyp` (or `styp`).
    expect(new TextDecoder().decode(head.subarray(4, 8))).toMatch(/^(ftyp|styp)$/)

    const response = await fetch(file.url, { headers: { Range: 'bytes=16-31' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe(`bytes 16-31/${file.size}`)
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Content-Length')).toBe('16')
    const middle = new Uint8Array(await response.arrayBuffer())
    expect(middle).toEqual((await fetchRange(file.url, 0, 31)).subarray(16))

    // The last byte, and a range that runs past the end, which is cut where the file ends.
    expect((await fetchRange(file.url, file.size - 1, file.size - 1)).length).toBe(1)
    expect((await fetchRange(file.url, file.size - 4, file.size + 1000)).length).toBe(4)

    const beyond = await fetch(file.url, { headers: { Range: `bytes=${file.size}-` } })
    expect(beyond.status).toBe(416)
    await beyond.arrayBuffer()
  })

  test('plays an ffmpeg-made fragmented MP4 through Media Source', async (ctx) => {
    const file = fragmentedFile()
    if (!file) return ctx.skip('The corpus has no fragmented.mp4 (run corpus:make).')
    expect(MediaSource.isTypeSupported(FRAGMENTED_TYPE), FRAGMENTED_TYPE).toBe(true)

    const bytes = await fetchRange(file.url, 0, file.size - 1)
    expect(bytes.length).toBe(file.size)

    const mediaSource = new MediaSource()
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    document.body.append(video)
    const objectUrl = URL.createObjectURL(mediaSource)
    try {
      const opened = mediaSourceOpened(video, mediaSource)
      video.src = objectUrl
      await opened

      const buffer = mediaSource.addSourceBuffer(FRAGMENTED_TYPE)
      await appendAll(buffer, [bytes])
      mediaSource.endOfStream()

      await video.play()
      expect(await startsPlaying(video, 5000)).toBe(true)
    } finally {
      video.pause()
      video.removeAttribute('src')
      video.load()
      video.remove()
      URL.revokeObjectURL(objectUrl)
    }
  })
})

describe('says at once what a video could not do', () => {
  /** A video element that is given bytes no browser can decode: it reports a MediaError at once. */
  function brokenVideo(): { video: HTMLVideoElement; done: () => void } {
    const video = document.createElement('video')
    video.muted = true
    document.body.append(video)
    const objectUrl = URL.createObjectURL(
      new Blob([new Uint8Array(64).fill(7)], { type: 'video/mp4' }),
    )
    video.src = objectUrl
    return {
      video,
      done: () => {
        video.removeAttribute('src')
        video.load()
        video.remove()
        URL.revokeObjectURL(objectUrl)
      },
    }
  }

  test('startsPlaying throws with the error’s code and message as soon as the video has one', async () => {
    const { video, done } = brokenVideo()
    try {
      const began = performance.now()
      await expect(startsPlaying(video, 20_000)).rejects.toThrow(/MediaError 4/)
      // It did not wait out the 20 s it was given.
      expect(performance.now() - began).toBeLessThan(10_000)
    } finally {
      done()
    }
  })

  test('mediaSourceOpened rejects with the video’s error rather than wait for a source that never opens', async () => {
    const { video, done } = brokenVideo()
    try {
      await expect(mediaSourceOpened(video, new MediaSource())).rejects.toThrow(/MediaError 4/)
    } finally {
      done()
    }
  })

  /** Rejects if the promise has not settled within `ms`: a wait that would otherwise last the whole test's timeout. */
  async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Still waiting after ${ms} ms.`))
          }, ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  test('mediaSourceOpened settles at once for a media source that is already open', async () => {
    const mediaSource = new MediaSource()
    const video = document.createElement('video')
    document.body.append(video)
    const objectUrl = URL.createObjectURL(mediaSource)
    try {
      const opened = mediaSourceOpened(video, mediaSource)
      video.src = objectUrl
      await opened
      expect(mediaSource.readyState).toBe('open')
      // The event has come and gone: a second call must not wait for another.
      await within(mediaSourceOpened(video, mediaSource), 3000)
    } finally {
      video.removeAttribute('src')
      video.load()
      video.remove()
      URL.revokeObjectURL(objectUrl)
    }
  })

  test('mediaSourceOpened rejects at once for a video that already has an error', async () => {
    const { video, done } = brokenVideo()
    try {
      expect(await waitUntil(() => video.error !== null, 10_000)).toBe(true)
      // The error event has come and gone: the call must see the error, not wait for another.
      await expect(within(mediaSourceOpened(video, new MediaSource()), 3000)).rejects.toThrow(
        /MediaError 4/,
      )
    } finally {
      done()
    }
  })

  test('waitFor rejects with the video’s error as soon as it has one, rather than wait for the event', async () => {
    const { video, done } = brokenVideo()
    try {
      await expect(within(waitFor(video, 'seeked', 20_000), 3000)).rejects.toThrow(/MediaError 4/)
    } finally {
      done()
    }
  })

  test('playsUntil returns as soon as the video has ended, short of the time asked for', async (ctx) => {
    const { url, files } = inject('corpus')
    const file = files.find((entry) => entry.synthetic && entry.name.endsWith('/fragmented.mp4'))
    if (!file) return ctx.skip('The corpus has no fragmented.mp4 (run corpus:make).')
    const mediaSource = new MediaSource()
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    document.body.append(video)
    const objectUrl = URL.createObjectURL(mediaSource)
    try {
      const opened = mediaSourceOpened(video, mediaSource)
      video.src = objectUrl
      await opened
      const buffer = mediaSource.addSourceBuffer(FRAGMENTED_TYPE)
      await appendAll(buffer, [await fetchRange(`${url}/file/${file.id}`, 0, file.size - 1)])
      mediaSource.endOfStream()
      // Eight times as fast, so that the end of the clip comes in a second or two (headed Firefox does not play at 16).
      video.playbackRate = 8
      await video.play()
      const began = performance.now()
      const played = await playsUntil(video, 1_000_000, 25_000)
      expect(played.reached).toBe(false)
      expect(video.ended).toBe(true)
      // It did not wait out the 25 s it was given.
      expect(performance.now() - began).toBeLessThan(10_000)
    } finally {
      video.pause()
      video.removeAttribute('src')
      video.load()
      video.remove()
      URL.revokeObjectURL(objectUrl)
    }
  })
})
