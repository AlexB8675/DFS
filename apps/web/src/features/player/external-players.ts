// Players outside the browser that play a stream link (DESIGN.md §6.7), in
// the order they are offered: the device's own player first, then VLC (the
// user's decisions, 2026-10-10). A page opens an app only through an address
// the app registers (a phone's), or a file it opens: on a computer, a
// playlist of the one link, downloaded and opened. A stream link is an
// address any player that plays addresses opens, so another player is another
// entry here: its name, and how it opens a link on each device.

/** The kind of device the page runs on, as far as opening another app goes. */
export type Device = 'ios' | 'android' | 'mac' | 'windows' | 'other'

/** What a player is asked to play. */
export interface Stream {
  url: string
  title: string
  kind: 'video' | 'audio'
}

/** How a player opens a stream: an address to go to, or a playlist to download and open. */
export type Opening =
  { kind: 'address'; url: string } | { kind: 'playlist'; file: Blob; fileName: string }

export interface ExternalPlayer {
  id: string
  /** Its name in Open in… on this device. */
  name: (device: Device) => string
  /** Whether it is offered on this device. */
  offered: (device: Device) => boolean
  /** How it opens a stream on this device, where it is offered. */
  opening: (stream: Stream, device: Device) => Opening
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
 * The device's own player. On Android, the app it plays video (or audio)
 * with, or its Open with list, as an intent naming no app. On a computer,
 * whatever opens playlists (`.m3u`): Windows' Media Player, unless another
 * player took them. An iPhone's is Safari's own, the browser's, and a Mac's
 * playlists go to Music, so there is none.
 */
export const NATIVE: ExternalPlayer = {
  id: 'native',
  name: (device) => (device === 'android' ? 'This phone’s player' : 'This computer’s player'),
  offered: (device) => device === 'android' || device === 'windows' || device === 'other',
  opening: (stream, device) =>
    device === 'android'
      ? // No fallback: the browser would download the whole file instead.
        { kind: 'address', url: intent(stream.url, [`type=${stream.kind}/*`]) }
      : { kind: 'playlist', file: m3u(stream), fileName: `${baseName(stream.title)}.m3u` },
}

const VLC_ANDROID = 'org.videolan.vlc'

/**
 * VLC: on an iPhone or iPad, its x-callback address (`stream` plays without
 * asking whether to download); on Android, an intent naming its package, else
 * its page in the store; on a computer, where it registers no address, its
 * own playlist (`.xspf`), which another player doesn't take.
 */
export const VLC: ExternalPlayer = {
  id: 'vlc',
  name: () => 'VLC',
  offered: () => true,
  opening: (stream, device) => {
    if (device === 'ios') {
      return {
        kind: 'address',
        url: `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(stream.url)}`,
      }
    }
    if (device === 'android') {
      return {
        kind: 'address',
        url: intent(stream.url, [
          `package=${VLC_ANDROID}`,
          `type=${stream.kind}/*`,
          `S.title=${encodeURIComponent(stream.title)}`,
          `S.browser_fallback_url=${encodeURIComponent(`https://play.google.com/store/apps/details?id=${VLC_ANDROID}`)}`,
        ]),
      }
    }
    return { kind: 'playlist', file: xspf(stream), fileName: `${baseName(stream.title)}.xspf` }
  },
}

/** The players a stream link is offered for, in this order. */
export const EXTERNAL_PLAYERS: readonly ExternalPlayer[] = [NATIVE, VLC]

/** Those offered on this device, in their order. */
export function playersFor(device: Device): ExternalPlayer[] {
  return EXTERNAL_PLAYERS.filter((player) => player.offered(device))
}

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

/** A playlist of the one link, as Windows' Media Player and most players read it. */
export function m3u(stream: Stream): Blob {
  const title = stream.title.replace(/[\r\n]+/g, ' ')
  return new Blob([`#EXTM3U\r\n#EXTINF:-1,${title}\r\n${stream.url}\r\n`], {
    type: 'audio/x-mpegurl',
  })
}

/** VLC's own playlist of the one link. */
export function xspf(stream: Stream): Blob {
  return new Blob(
    [
      '<?xml version="1.0" encoding="UTF-8"?>\n',
      '<playlist xmlns="http://xspf.org/ns/0/" version="1"><trackList><track>',
      `<location>${escapeXml(stream.url)}</location><title>${escapeXml(stream.title)}</title>`,
      '</track></trackList></playlist>\n',
    ],
    { type: 'application/xspf+xml' },
  )
}

/** A file's name without its extension, for its playlist's. */
function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name
}

function escapeXml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] ?? char,
  )
}
