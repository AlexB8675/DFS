// Players outside the browser that play a stream link (DESIGN.md §6.7):
// VLC for now. A stream link is an address any player that plays addresses
// opens, so another player is another entry here: its name, where to get
// it, and how a page opens a link in it on each device, if a page can.

/** The kind of device the page runs on, as far as opening another app goes. */
export type Device = 'ios' | 'android' | 'mac' | 'windows' | 'other'

export interface ExternalPlayer {
  id: string
  name: string
  /** Where to get it for this device. */
  getUrl: (device: Device) => string
  /**
   * An address that opens `streamUrl` in it on this device; `null` where a
   * page can't open it, as on a computer, where the playlist file and the
   * link to paste stand in.
   */
  openUrl: (
    stream: { url: string; title: string; kind: 'video' | 'audio' },
    device: Device,
  ) => string | null
  /** How to open a copied link in it by hand on this device. */
  pasteHint: (device: Device) => string
}

const VLC_ANDROID = 'org.videolan.vlc'

export const VLC: ExternalPlayer = {
  id: 'vlc',
  name: 'VLC',
  getUrl: (device) =>
    device === 'ios'
      ? 'https://apps.apple.com/app/vlc-media-player/id650377962'
      : device === 'android'
        ? `https://play.google.com/store/apps/details?id=${VLC_ANDROID}`
        : 'https://www.videolan.org/vlc/',
  openUrl: (stream, device) => {
    // VLC for iOS's x-callback-url: `stream` plays it without asking whether to download.
    if (device === 'ios') {
      return `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(stream.url)}`
    }
    // Chrome's intent addresses: the link, in VLC's package, else VLC's page in the store.
    if (device === 'android') {
      const url = new URL(stream.url)
      return [
        `intent://${url.host}${url.pathname}${url.search}#Intent`,
        `scheme=${url.protocol.slice(0, -1)}`,
        `package=${VLC_ANDROID}`,
        `type=${stream.kind}/*`,
        `S.title=${encodeURIComponent(stream.title)}`,
        `S.browser_fallback_url=${encodeURIComponent(VLC.getUrl('android'))}`,
        'end',
      ].join(';')
    }
    // VLC on a computer registers no address of its own.
    return null
  },
  pasteHint: (device) =>
    device === 'mac'
      ? 'In VLC, choose File → Open Network (⌘N), paste the link and choose Open.'
      : device === 'ios' || device === 'android'
        ? 'In VLC, open a network stream and paste the link.'
        : 'In VLC, choose Media → Open Network Stream (Ctrl+N), paste the link and choose Play.',
}

/** The players a stream link is offered for, the first by default. */
export const EXTERNAL_PLAYERS: readonly ExternalPlayer[] = [VLC]

/** This device, from what the browser says it is. An iPad says it is a Mac, but touches. */
export function currentDevice(
  userAgent = navigator.userAgent,
  touchPoints = navigator.maxTouchPoints,
): Device {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios'
  if (userAgent.includes('Android')) return 'android'
  if (/Macintosh|Mac OS X/.test(userAgent)) return touchPoints > 1 ? 'ios' : 'mac'
  if (userAgent.includes('Windows')) return 'windows'
  return 'other'
}

/**
 * A playlist of the one link, which a computer opens in its player for
 * playlists (VLC, once installed, usually): one click instead of pasting.
 */
export function playlistFile(stream: { url: string; title: string }): Blob {
  const title = stream.title.replace(/[\r\n]+/g, ' ')
  return new Blob([`#EXTM3U\n#EXTINF:-1,${title}\n${stream.url}\n`], {
    type: 'audio/x-mpegurl',
  })
}
