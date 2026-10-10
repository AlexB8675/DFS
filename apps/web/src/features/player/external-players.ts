// Players outside the browser that play a stream link (DESIGN.md §6.7), in
// the order they are offered: the device's own player first (the user's
// decision, 2026-10-10), then VLC. A stream link is an address any player
// that plays addresses opens, so another player is another entry here: its
// name, and how a page opens a link in it on each device, if a page can.

/** The kind of device the page runs on, as far as opening another app goes. */
export type Device = 'ios' | 'android' | 'mac' | 'windows' | 'other'

/** What a player is asked to play. */
export interface Stream {
  url: string
  title: string
  kind: 'video' | 'audio'
}

export interface ExternalPlayer {
  id: string
  /** Its name in “Open in …” on this device. */
  name: (device: Device) => string
  /**
   * An address that opens the stream in it on this device; `null` where a
   * page can't open it (a computer's player, which only takes a pasted link).
   */
  openUrl: (stream: Stream, device: Device) => string | null
  /** How to open a copied link in it by hand on this device; `null` where it isn't worth saying. */
  pasteHint: (device: Device) => string | null
  /** Where to get it for this device; `null` for the device's own. */
  getUrl: (device: Device) => string | null
}

/** Chrome's intent address for `url`, `extras` its parameters before the end (`package=…`). */
function intent(url: string, extras: string[]): string {
  const address = new URL(url)
  return [
    `intent://${address.host}${address.pathname}${address.search}#Intent`,
    `scheme=${address.protocol.slice(0, -1)}`,
    ...extras,
    'end',
  ].join(';')
}

/**
 * The device's own player: on Android, the app it plays video (or audio)
 * with, or its Open with list, as an intent naming no app. Elsewhere a page
 * can't open one: an iPhone's is Safari's own, which plays what the browser
 * plays, and a computer's takes no address from a page.
 */
export const NATIVE: ExternalPlayer = {
  id: 'native',
  name: (device) => (device === 'android' ? 'this phone’s player' : 'this device’s player'),
  openUrl: (stream, device) =>
    device === 'android'
      ? // No fallback: the browser would download the whole file instead.
        intent(stream.url, [`type=${stream.kind}/*`])
      : null,
  pasteHint: () => null,
  getUrl: () => null,
}

const VLC_ANDROID = 'org.videolan.vlc'

export const VLC: ExternalPlayer = {
  id: 'vlc',
  name: () => 'VLC',
  openUrl: (stream, device) => {
    // VLC for iOS's x-callback-url: `stream` plays it without asking whether to download.
    if (device === 'ios') {
      return `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(stream.url)}`
    }
    // An intent naming VLC's package, else VLC's page in the store.
    if (device === 'android') {
      return intent(stream.url, [
        `package=${VLC_ANDROID}`,
        `type=${stream.kind}/*`,
        `S.title=${encodeURIComponent(stream.title)}`,
        `S.browser_fallback_url=${encodeURIComponent(`https://play.google.com/store/apps/details?id=${VLC_ANDROID}`)}`,
      ])
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
  getUrl: (device) =>
    device === 'ios'
      ? 'https://apps.apple.com/app/vlc-media-player/id650377962'
      : device === 'android'
        ? `https://play.google.com/store/apps/details?id=${VLC_ANDROID}`
        : 'https://www.videolan.org/vlc/',
}

/** The players a stream link is offered for, in this order. */
export const EXTERNAL_PLAYERS: readonly ExternalPlayer[] = [NATIVE, VLC]

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
