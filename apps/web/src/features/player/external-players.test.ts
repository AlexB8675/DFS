import { describe, expect, it } from 'vitest'
import {
  currentDevice,
  NATIVE,
  playersFor,
  VLC,
  type Device,
  type Opening,
} from './external-players'

// Opening a stream link in another player (DESIGN.md §6.7): the device's own first, then VLC.

const stream = {
  url: 'https://dfs.example/api/stream/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_',
  title: 'A film & more (cut).mkv',
  kind: 'video' as const,
}

/** The players offered on a device, by name, in their order. */
function offered(device: Device): string[] {
  return playersFor(device).map((player) => player.name(device))
}

/** What a playlist opening holds, as text. */
async function playlist(
  opening: Opening,
): Promise<{ fileName: string; type: string; text: string }> {
  if (opening.kind !== 'playlist') throw new Error('Not a playlist.')
  return { fileName: opening.fileName, type: opening.file.type, text: await opening.file.text() }
}

describe('opening a stream link in another player (§6.7)', () => {
  it('offers the device’s own player first where it has one, then VLC', () => {
    expect(offered('android')).toEqual(['This phone’s player', 'VLC'])
    expect(offered('windows')).toEqual(['This computer’s player', 'VLC'])
    expect(offered('other')).toEqual(['This computer’s player', 'VLC'])
    // An iPhone's own is the browser's; a Mac's playlists go to Music.
    expect(offered('ios')).toEqual(['VLC'])
    expect(offered('mac')).toEqual(['VLC'])
  })

  it('opens a phone’s players at once: an intent on Android, VLC’s address on iOS', () => {
    expect(NATIVE.opening(stream, 'android')).toEqual({
      kind: 'address',
      url: 'intent://dfs.example/api/stream/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_#Intent;scheme=https;type=video/*;end',
    })
    expect(VLC.opening(stream, 'android')).toEqual({
      kind: 'address',
      url: 'intent://dfs.example/api/stream/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_#Intent;scheme=https;package=org.videolan.vlc;type=video/*;S.title=A%20film%20%26%20more%20(cut).mkv;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dorg.videolan.vlc;end',
    })
    expect(VLC.opening(stream, 'ios')).toEqual({
      kind: 'address',
      url: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(stream.url)}`,
    })
  })

  it('opens a computer’s from a playlist of the link: .m3u for its own, VLC’s .xspf', async () => {
    expect(await playlist(NATIVE.opening(stream, 'windows'))).toEqual({
      fileName: 'A film & more (cut).m3u',
      type: 'audio/x-mpegurl',
      text: `#EXTM3U\r\n#EXTINF:-1,A film & more (cut).mkv\r\n${stream.url}\r\n`,
    })
    const vlc = await playlist(VLC.opening(stream, 'mac'))
    expect(vlc.fileName).toBe('A film & more (cut).xspf')
    expect(vlc.type).toBe('application/xspf+xml')
    expect(vlc.text).toContain(`<location>${stream.url}</location>`)
    expect(vlc.text).toContain('<title>A film &amp; more (cut).mkv</title>')
    // A title on two lines stays one entry.
    const twoLines = await playlist(NATIVE.opening({ ...stream, title: 'Two\nlines' }, 'other'))
    expect(twoLines.text).toContain('#EXTINF:-1,Two lines\r\n')
  })

  it('tells devices apart by what their browsers say, an iPad by its touch', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15'
    const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140'
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140'
    expect(currentDevice(iphone, 5)).toBe('ios')
    expect(currentDevice(ipad, 5)).toBe('ios')
    expect(currentDevice(ipad, 0)).toBe('mac')
    expect(currentDevice(android, 5)).toBe('android')
    expect(currentDevice(windows, 0)).toBe('windows')
    expect(currentDevice('Mozilla/5.0 (X11; Linux x86_64)', 0)).toBe('other')
  })
})
