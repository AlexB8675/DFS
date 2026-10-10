import { describe, expect, it } from 'vitest'
import { currentDevice, playlistFile, VLC } from './external-players'

// Opening a stream link in another player (DESIGN.md §6.7).

const stream = {
  url: 'https://dfs.example/api/stream/u.abc.def.123.mac/A%20film%20(cut).mkv',
  title: 'A film (cut).mkv',
  kind: 'video' as const,
}

describe('opening a stream link in VLC (§6.7)', () => {
  it('opens VLC for iOS with its x-callback address, to stream rather than download', () => {
    expect(VLC.openUrl(stream, 'ios')).toBe(
      `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(stream.url)}`,
    )
  })

  it('opens VLC for Android with an intent, else its page in the store', () => {
    expect(VLC.openUrl(stream, 'android')).toBe(
      'intent://dfs.example/api/stream/u.abc.def.123.mac/A%20film%20(cut).mkv#Intent;scheme=https;package=org.videolan.vlc;type=video/*;S.title=A%20film%20(cut).mkv;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dorg.videolan.vlc;end',
    )
  })

  it('can’t open VLC on a computer, which has a playlist to open and a link to paste', async () => {
    expect(VLC.openUrl(stream, 'windows')).toBeNull()
    expect(VLC.openUrl(stream, 'mac')).toBeNull()
    expect(VLC.pasteHint('windows')).toContain('Open Network Stream (Ctrl+N)')
    expect(VLC.pasteHint('mac')).toContain('(⌘N)')
    const playlist = playlistFile({ url: stream.url, title: 'Two\nlines.mkv' })
    expect(playlist.type).toBe('audio/x-mpegurl')
    expect(await playlist.text()).toBe(`#EXTM3U\n#EXTINF:-1,Two lines.mkv\n${stream.url}\n`)
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
    expect(VLC.getUrl('ios')).toContain('apps.apple.com')
    expect(VLC.getUrl('other')).toBe('https://www.videolan.org/vlc/')
  })
})
