import {
  deliverySchema,
  fileMediaSchema,
  isTextSubtitles,
  MAX_CONNECTION_TEST_BYTES,
  playbackSchema,
} from '@dfs/shared'
import type { ApiClient } from './client.ts'
import type { SuiteContext } from './context.ts'
import { createFolder, text, uploadFile, workspace } from './files.ts'

/**
 * Audio and video (DESIGN.md §6.7, §10.4): what a file holds, what a player
 * needs to start, where each user stopped, subtitle files beside a video as
 * WebVTT, and the version a player names. The API's runner stands in for the
 * media service, which says every file is a video.
 */
export function mediaTests({
  describe,
  it,
  expect,
  owner,
  newUser,
  activated,
}: SuiteContext): void {
  async function playback(client: ApiClient, nodeId: string) {
    return client.call('GET', `/files/${nodeId}/playback`, playbackSchema)
  }

  describe('audio and video (§6.7, §10.4)', () => {
    it('says what a video holds, in its current version, and that other files aren’t media', async () => {
      const client = await owner()
      const root = await workspace(client)
      const video = await uploadFile(
        client,
        root.id,
        'clip.mp4',
        text('a video, as far as anyone knows'),
      )
      const media = await client.call('GET', `/files/${video.nodeId}/media`, fileMediaSchema)
      expect(media.versionId).toBe(video.versionId)
      expect(media.info?.kind).toBe('video')

      const empty = await uploadFile(client, root.id, 'empty.mp4', new Uint8Array(0))
      expect(await client.call('GET', `/files/${empty.nodeId}/media`, fileMediaSchema)).toEqual({
        versionId: empty.versionId,
        info: null,
        problem: 'It’s empty.',
      })

      const notes = await uploadFile(client, root.id, 'notes.txt', text('notes'))
      for (const path of ['media', 'playback']) {
        expect(await client.error('GET', `/files/${notes.nodeId}/${path}`)).toEqual({
          status: 422,
          code: 'not_media',
        })
      }
    })

    it('lists the subtitle files beside a video, with what their names say', async () => {
      const client = await owner()
      const folder = await createFolder(client, (await workspace(client)).id, 'Film')
      const video = await uploadFile(client, folder.id, 'Film.mkv', text('matroska'))
      const plain = await uploadFile(client, folder.id, 'Film.srt', text(''))
      const italian = await uploadFile(client, folder.id, 'film.ita.srt', text(''))
      const forced = await uploadFile(client, folder.id, 'Film.en.forced.vtt', text(''))
      const trashed = await uploadFile(client, folder.id, 'Film.de.srt', text(''))
      await client.send('POST', '/nodes/trash', { json: { ids: [trashed.nodeId] } })
      for (const name of ['Film.txt', 'Other.srt', 'Film 2.srt']) {
        await uploadFile(client, folder.id, name, text(''))
      }

      const { versionId, positionMs, subtitleFiles } = await playback(client, video.nodeId)
      expect(versionId).toBe(video.versionId)
      expect(positionMs).toBeNull()
      const byId = (id: string) => subtitleFiles.find((file) => file.id === id)
      expect(subtitleFiles).toHaveLength(3)
      expect(byId(plain.nodeId)).toEqual({
        id: plain.nodeId,
        name: 'Film.srt',
        language: null,
        forced: false,
        hearingImpaired: false,
      })
      expect(byId(italian.nodeId)).toMatchObject({ language: 'it', forced: false })
      expect(byId(forced.nodeId)).toMatchObject({ language: 'en', forced: true })
    })

    it('serves a subtitle file beside a video as WebVTT, for the version being played', async () => {
      const client = await owner()
      const folder = await createFolder(client, (await workspace(client)).id, 'Subtitled')
      const video = await uploadFile(client, folder.id, 'Talk.mp4', text('mp4'))
      const srt = await uploadFile(
        client,
        folder.id,
        'Talk.en.srt',
        text('1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> & welcome\r\n'),
      )
      const path = `/files/${video.nodeId}/media/${video.versionId}/subtitles/${srt.nodeId}.vtt`
      const response = await client.fetch('GET', path)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/vtt; charset=utf-8')
      expect(await response.text()).toBe(
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n<i>Hello</i> &amp; welcome\n',
      )

      // Only a subtitle file beside it: not one elsewhere, nor another file.
      const elsewhere = await uploadFile(client, (await workspace(client)).id, 'Talk.srt', text(''))
      for (const id of [elsewhere.nodeId, video.nodeId, crypto.randomUUID()]) {
        expect(
          await client.error(
            'GET',
            `/files/${video.nodeId}/media/${video.versionId}/subtitles/${id}.vtt`,
          ),
        ).toEqual({ status: 404, code: 'not_found' })
      }

      await uploadFile(client, folder.id, 'Talk.mp4', text('a new version'))
      expect(await client.error('GET', path)).toEqual({ status: 412, code: 'version_changed' })
    })

    it('serves a text subtitle stream inside a video as WebVTT, and no other stream', async () => {
      const client = await owner()
      const root = await workspace(client)
      const video = await uploadFile(client, root.id, 'Inside.mkv', text('matroska'))
      const media = await client.call('GET', `/files/${video.nodeId}/media`, fileMediaSchema)
      const inside = media.info?.streams.find((stream) => isTextSubtitles(stream))
      const audio = media.info?.streams.find((stream) => stream.type === 'audio')
      if (!inside || !audio) throw new Error('The video has no subtitles or sound inside.')
      const path = (index: number) =>
        `/files/${video.nodeId}/media/${video.versionId}/subtitles/${String(index)}.vtt`

      const response = await client.fetch('GET', path(inside.index))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/vtt; charset=utf-8')
      expect(await response.text()).toMatch(/^WEBVTT\n/)
      expect(await client.error('GET', path(audio.index))).toEqual({
        status: 404,
        code: 'not_found',
      })
    })

    it('says how much of a version a user’s player has been sent', async () => {
      const client = await owner()
      const root = await workspace(client)
      const video = await uploadFile(client, root.id, 'Delivered.mp4', text('twelve bytes'))
      const path = `/files/${video.nodeId}/media/${video.versionId}/delivery`
      expect((await client.call('GET', path, deliverySchema)).bytes).toBe(0)
      const read = await client.fetch(
        'GET',
        `/files/${video.nodeId}/content?version=${video.versionId}`,
      )
      expect((await read.arrayBuffer()).byteLength).toBe(12)
      expect((await client.call('GET', path, deliverySchema)).bytes).toBe(12)
    })

    it('sends bytes for testing the connection, within a limit', async () => {
      const client = await owner()
      const response = await client.fetch('GET', '/connection-test?bytes=300000')
      expect(response.status).toBe(200)
      expect((await response.arrayBuffer()).byteLength).toBe(300_000)
      expect(
        await client.error(
          'GET',
          `/connection-test?bytes=${String(MAX_CONNECTION_TEST_BYTES + 1)}`,
        ),
      ).toMatchObject({ status: 400 })
    })

    it('takes a player’s report of how a play went, within bounds', async () => {
      const client = await owner()
      const root = await workspace(client)
      const video = await uploadFile(client, root.id, 'Reported.mp4', text('mp4'))
      const report = {
        versionId: video.versionId,
        outcome: 'played',
        firstFrameMs: 1850,
        startMs: 2400,
        openMs: 64_000,
        stalls: 2,
        stallMs: 4100,
        seeks: 3,
        seekWaitMs: 9800,
        frames: 3000,
        droppedFrames: 12,
        arrivalBitsPerSecond: 2_700_000,
        decoding: { supported: true, smooth: true, powerEfficient: true },
        problem: null,
      }
      const path = `/files/${video.nodeId}/playback-report`
      await client.send('POST', path, { json: report })
      expect(await client.error('POST', path, { json: { ...report, stalls: -1 } })).toMatchObject({
        status: 400,
      })
      const notes = await uploadFile(client, root.id, 'notes.txt', text('notes'))
      expect(
        await client.error('POST', `/files/${notes.nodeId}/playback-report`, { json: report }),
      ).toEqual({ status: 422, code: 'not_media' })
    })

    it('keeps where a user stopped, for them alone and that version', async () => {
      const client = await owner()
      const root = await workspace(client)
      const video = await uploadFile(client, root.id, 'Long film.mkv', text('first'))
      const position = { versionId: video.versionId, positionMs: 754_250 }
      await client.send('PUT', `/files/${video.nodeId}/position`, { json: position })
      expect((await playback(client, video.nodeId)).positionMs).toBe(754_250)
      await client.send('PUT', `/files/${video.nodeId}/position`, {
        json: { ...position, positionMs: 800_000 },
      })
      expect((await playback(client, video.nodeId)).positionMs).toBe(800_000)

      await client.send('DELETE', `/files/${video.nodeId}/position`)
      expect((await playback(client, video.nodeId)).positionMs).toBeNull()

      // Another user doesn't see the file at all.
      const { username, temporaryPassword } = await newUser(client)
      const other = await activated(username, temporaryPassword)
      expect(
        await other.error('PUT', `/files/${video.nodeId}/position`, { json: position }),
      ).toEqual({ status: 404, code: 'not_found' })

      // A new version starts over, and a position in the old one isn't kept.
      const owner2 = await owner()
      await owner2.send('PUT', `/files/${video.nodeId}/position`, { json: position })
      const replaced = await uploadFile(owner2, root.id, 'Long film.mkv', text('second'))
      expect(await playback(owner2, video.nodeId)).toMatchObject({
        versionId: replaced.versionId,
        positionMs: null,
      })
      expect(
        await owner2.error('PUT', `/files/${video.nodeId}/position`, { json: position }),
      ).toEqual({ status: 412, code: 'version_changed' })
    })

    it('serves only the version a player names, once the file has another', async () => {
      const client = await owner()
      const root = await workspace(client)
      const video = await uploadFile(client, root.id, 'Replaced.mp4', text('first'))
      const path = `/files/${video.nodeId}/content?version=${video.versionId}`
      const first = await client.fetch('GET', path, { headers: { Range: 'bytes=0-2' } })
      expect(first.status).toBe(206)
      expect(await first.text()).toBe('fir')

      await uploadFile(client, root.id, 'Replaced.mp4', text('second'))
      expect(await client.error('GET', path)).toEqual({ status: 412, code: 'version_changed' })
    })
  })
}
