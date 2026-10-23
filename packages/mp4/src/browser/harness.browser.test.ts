// The browser harness itself (DESIGN.md §10.4, D45): a real browser reads the
// corpus from the Range server by `inject('corpus')`, and plays a file that
// FFmpeg made through Media Source. Later suites stand on this: if it fails, they
// can't say anything about the repackager.

import { describe, expect, inject, test } from 'vitest'
import { appendAll, fetchRange, startsPlaying } from './media.ts'

/** The synthetic H.264 High 720p30 with AAC, which FFmpeg wrote as a fragmented file. */
const FRAGMENTED_TYPE = 'video/mp4; codecs="avc1.64001f,mp4a.40.2"'

function fragmentedFile(): { url: string; size: number } | undefined {
  const { url, files } = inject('corpus')
  const file = files.find((entry) => entry.name === 'fragmented.mp4')
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
      const opened = new Promise<void>((resolve) => {
        mediaSource.addEventListener('sourceopen', () => {
          resolve()
        })
      })
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
