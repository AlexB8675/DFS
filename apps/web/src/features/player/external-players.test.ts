import { describe, expect, it } from 'vitest'
import { currentDevice, EXTERNAL_PLAYERS, NATIVE, VLC, type Device } from './external-players'

// Opening a stream link in another player (DESIGN.md §6.7): the device's own first, then VLC.

const stream = {
  url: 'https://dfs.example/api/stream/s.abc.0.def.mac/A%20film%20(cut).mkv',
  title: 'A film (cut).mkv',
  kind: 'video' as const,
}

/** The players a tap opens on a device, by name, in their order. */
function offered(device: Device): string[] {
  return EXTERNAL_PLAYERS.filter((player) => player.openUrl(stream, device) !== null).map(
    (player) => player.name(device),
  )
}

describe('opening a stream link in another player (§6.7)', () => {
  it('offers the device’s own player first, where a page can open it, then VLC', () => {
    expect(offered('android')).toEqual(['this phone’s player', 'VLC'])
    expect(offered('ios')).toEqual(['VLC'])
    // A computer's players take no address from a page: the link is copied instead.
    expect(offered('windows')).toEqual([])
    expect(offered('mac')).toEqual([])
    expect(offered('other')).toEqual([])
  })

  it('opens an Android phone’s player with an intent naming no app, and no download to fall back on', () => {
    expect(NATIVE.openUrl(stream, 'android')).toBe(
      'intent://dfs.example/api/stream/s.abc.0.def.mac/A%20film%20(cut).mkv#Intent;scheme=https;type=video/*;end',
    )
    expect(NATIVE.openUrl({ ...stream, kind: 'audio' }, 'android')).toContain(';type=audio/*;')
  })

  it('opens VLC for iOS with its x-callback address, to stream rather than download', () => {
    expect(VLC.openUrl(stream, 'ios')).toBe(
      `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(stream.url)}`,
    )
  })

  it('opens VLC for Android with an intent naming it, else its page in the store', () => {
    expect(VLC.openUrl(stream, 'android')).toBe(
      'intent://dfs.example/api/stream/s.abc.0.def.mac/A%20film%20(cut).mkv#Intent;scheme=https;package=org.videolan.vlc;type=video/*;S.title=A%20film%20(cut).mkv;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dorg.videolan.vlc;end',
    )
  })

  it('says where to paste a link in VLC on a computer, and where to get it', () => {
    expect(VLC.pasteHint('windows')).toContain('Open Network Stream (Ctrl+N)')
    expect(VLC.pasteHint('mac')).toContain('(⌘N)')
    expect(VLC.getUrl('ios')).toContain('apps.apple.com')
    expect(VLC.getUrl('other')).toBe('https://www.videolan.org/vlc/')
    expect(NATIVE.getUrl('android')).toBeNull()
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
