import type { TimelineConnection, TimelineEventInput } from '@dfs/shared'
import { clipText } from './recorder'

// What the page around a video does, for the play's timeline (§10.4, §16): it
// going online or offline, hiding or showing, its connection changing, and
// leaving. It is the play's own, from the moment the viewer opens the video:
// the element may not exist yet, or ever, and a hidden page's last batch must
// hold the `hidden` event that says why it went. Every number is rounded and
// held to the shared schema's bounds, so the recorder doesn't refuse an event
// for what a browser reports oddly.

/** The schema's bound on a connection's figures. */
const MAX_CONNECTION = 1e6

/** What `navigator.connection` has, which TypeScript's DOM library leaves out. */
interface ConnectionLike extends EventTarget {
  effectiveType?: unknown
  downlink?: unknown
  rtt?: unknown
  saveData?: unknown
}

/** A figure of the connection when it is a number from 0 up, held to the schema's range; else `null`. */
function figure(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(MAX_CONNECTION, value)
}

function connectionObject(): ConnectionLike | null {
  if (!('connection' in navigator)) return null
  const connection: unknown = navigator.connection
  return typeof connection === 'object' && connection !== null
    ? (connection as ConnectionLike)
    : null
}

function describeConnection(connection: ConnectionLike): TimelineConnection {
  const type =
    typeof connection.effectiveType === 'string' ? clipText(connection.effectiveType, 10) : ''
  return {
    effectiveType: type === '' ? null : type,
    downlinkMbps: figure(connection.downlink),
    rttMs: figure(connection.rtt),
    saveData: typeof connection.saveData === 'boolean' ? connection.saveData : null,
  }
}

/** What `navigator.connection` says now, or `null` where the browser has no such thing. */
export function connectionNow(): TimelineConnection | null {
  const connection = connectionObject()
  return connection === null ? null : describeConnection(connection)
}

/**
 * Records what the page does through `record`, and asks `flushKeepalive` to
 * send what is kept when the page hides or leaves, until the function
 * returned is called, which removes every listener. Hiding is recorded
 * first and flushed after, so the batch that goes holds it. The timeline's
 * own flush, not this module's, does the sending.
 */
export function watchPage(
  record: (event: TimelineEventInput) => void,
  flushKeepalive: () => void,
): () => void {
  const cleanups: (() => void)[] = []

  const listen = (target: EventTarget, type: string, handler: () => void) => {
    target.addEventListener(type, handler)
    cleanups.push(() => {
      target.removeEventListener(type, handler)
    })
  }

  listen(window, 'online', () => {
    record({ type: 'network', online: true })
  })
  listen(window, 'offline', () => {
    record({ type: 'network', online: false })
  })
  listen(document, 'visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden'
    record({ type: 'visibility', hidden })
    if (hidden) flushKeepalive()
  })
  listen(window, 'pagehide', flushKeepalive)
  const connection = connectionObject()
  if (connection !== null) {
    listen(connection, 'change', () => {
      record({ type: 'connection', connection: describeConnection(connection) })
    })
  }

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    for (const cleanup of cleanups) cleanup()
  }
}
