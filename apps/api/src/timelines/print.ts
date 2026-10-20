import type { BatchRow, TimelineRead, TimelineRow } from '@dfs/db'
import type { ServedEvent } from '@dfs/shared'

// What `dfs timelines` and `dfs timeline` print (DESIGN.md §16): the play
// timelines and stream sessions the API keeps, as text an admin reads. Pure,
// so the tests need no database. Nothing here is trusted: user agents, file
// names and event texts come from outside, so control characters in them are
// spelled out and can't write to the admin's terminal.

/** The user agent's length in a list line. */
const LIST_AGENT_CHARS = 60

/** Text from outside with its control characters (C0, DEL, C1) written as \uXXXX. */
function safe(text: string): string {
  return text.replace(
    /\p{Cc}/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/** A date as ISO UTC down to the second, for the list. */
function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

/** What a timeline's events took, in KiB, rounded up. */
function kibibytes(bytes: number): string {
  return `${String(Math.ceil(bytes / 1024))} KiB`
}

/** A size read by eye: KiB, or MiB from one up, one decimal. */
function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)}MiB`
    : `${(bytes / 1024).toFixed(1)}KiB`
}

/** Who watched: the user, else the link they came through. */
function viewer(row: TimelineRow): string {
  if (row.username !== null) return safe(row.username)
  if (row.shareId !== null) return `link ${safe(row.shareId)}`
  return row.userId === null ? '(unknown)' : `user ${safe(row.userId)}`
}

function fileName(row: TimelineRow): string {
  return row.fileName === null ? '(deleted)' : safe(row.fileName)
}

/** One line per timeline: when, which, what, how much, who, and with what. */
function listLine(row: TimelineRow): string {
  const columns = [
    isoSeconds(row.startedAt),
    row.id,
    `${row.kind}/${row.via}`,
    fileName(row),
    plural(row.batches, 'batch', 'batches'),
    kibibytes(row.bytes),
    viewer(row),
    safe((row.userAgent ?? '-').slice(0, LIST_AGENT_CHARS).toWellFormed()),
  ]
  if (row.playId !== null) columns.push(`play ${row.playId}`)
  return columns.join('  ')
}

export function printTimelineList(rows: TimelineRow[]): string {
  return rows.length === 0 ? 'No timelines.' : rows.map(listLine).join('\n')
}

/** What a timeline is, before its events. */
function headerLines(timeline: TimelineRow): string[] {
  const lines = [
    `${timeline.kind}/${timeline.via}  ${timeline.id}`,
    `file ${fileName(timeline)}  node ${timeline.nodeId}`,
    `version ${timeline.versionId}`,
    `user ${viewer(timeline)}`,
    `address ${safe(timeline.address)}`,
    `agent ${timeline.userAgent === null ? 'unknown' : safe(timeline.userAgent)}`,
    timeline.clientStartedAt === null
      ? 'client start unknown'
      : `client start ${timeline.clientStartedAt.toISOString()}`,
    `server start ${timeline.startedAt.toISOString()}`,
    `${plural(timeline.batches, 'batch', 'batches')}, ${kibibytes(timeline.bytes)}`,
  ]
  if (timeline.playId !== null) lines.push(`play ${timeline.playId}`)
  return lines
}

function asRecord(event: unknown): Record<string, unknown> | null {
  return typeof event === 'object' && event !== null && !Array.isArray(event)
    ? (event as Record<string, unknown>)
    : null
}

/** An event's `t`, or NaN where it has none or isn't one: it is then unreadable. */
function eventTime(event: unknown): number {
  const record = asRecord(event)
  return record !== null && typeof record.type === 'string' && Number.isFinite(record.t)
    ? (record.t as number)
    : NaN
}

/** A time from the play's start as `+1.250s`; `+?s` for an unreadable event's. */
function clock(ms: number): string {
  if (!Number.isFinite(ms)) return '+?s'
  return `${ms < 0 ? '-' : '+'}${(Math.abs(ms) / 1000).toFixed(3)}s`
}

/** A field's value: text plain unless it has a space, a quote or an `=`; the rest as compact JSON. */
function fieldValue(value: unknown): string {
  if (typeof value === 'string' && /^[^\s"=\p{Cc}]+$/u.test(value)) return value
  return safe(JSON.stringify(value))
}

const isNumber = (value: unknown): value is number => typeof value === 'number'

function isFigures(value: unknown): boolean {
  const record = asRecord(value)
  return record !== null && isNumber(record.bytes) && isNumber(record.waitMs)
}

/** The event as a `served` one, if it has every field the printer reads. */
function asServed(record: Record<string, unknown>): ServedEvent | null {
  const sources = asRecord(record.sources)
  const valid =
    record.type === 'served' &&
    typeof record.address === 'string' &&
    isNumber(record.from) &&
    isNumber(record.to) &&
    isNumber(record.status) &&
    isNumber(record.bytes) &&
    isNumber(record.totalMs) &&
    isNumber(record.clientMs) &&
    (record.firstByteMs === null || isNumber(record.firstByteMs)) &&
    (record.gapMs === null || isNumber(record.gapMs)) &&
    typeof record.finished === 'boolean' &&
    typeof record.failed === 'boolean' &&
    typeof record.seek === 'boolean' &&
    sources !== null &&
    isFigures(sources.staging) &&
    isFigures(sources.cache) &&
    isFigures(sources.discord)
  return valid ? (record as unknown as ServedEvent) : null
}

/** A read the server answered, on one line; `address` only where it is new to the session. */
function servedFields(read: ServedEvent, showAddress: boolean): string {
  const parts = [
    `${String(read.from)}-${String(read.to)}`,
    String(read.status),
    size(read.bytes),
    `first=${read.firstByteMs === null ? 'none' : `${String(read.firstByteMs)}ms`}`,
    `total=${String(read.totalMs)}ms`,
  ]
  // Bits per millisecond are kilobits per second.
  if (read.totalMs > 0) parts.push(`${((read.bytes * 8) / read.totalMs / 1000).toFixed(1)}Mbit/s`)
  for (const name of ['staging', 'cache', 'discord'] as const) {
    const source = read.sources[name]
    if (source.bytes > 0) parts.push(`${name}=${size(source.bytes)}/${String(source.waitMs)}ms`)
  }
  parts.push(`client=${String(read.clientMs)}ms`)
  if (read.seek) parts.push('seek')
  if (read.gapMs !== null) parts.push(`gap=${String(read.gapMs)}ms`)
  if (!read.finished) parts.push('unfinished')
  if (read.failed) parts.push('failed')
  if (showAddress) parts.push(`addr=${safe(read.address)}`)
  return parts.join(' ')
}

/** An event, placed on a clock: `at` is its time in milliseconds, NaN where unreadable. */
interface Entry {
  at: number
  event: unknown
  /** What goes before its type: `server ` for a stream session's events on a play's clock. */
  label: string
  /** Whose event: the timeline's ID, for the address a session's reads came from. */
  source: string
}

/** The events of `batches` as entries, their `t` taken to a time by `place`. */
function entriesOf(
  batches: readonly BatchRow[],
  source: string,
  label: string,
  place: (t: number) => number,
): Entry[] {
  return batches.flatMap((batch) =>
    batch.events.map((event) => {
      const t = eventTime(event)
      return { at: Number.isNaN(t) ? NaN : place(t), event, label, source }
    }),
  )
}

/** In time order, ties as they came; what has no time goes last. */
function inOrder(entries: Entry[]): Entry[] {
  const key = (entry: Entry): number => (Number.isNaN(entry.at) ? Infinity : entry.at)
  return entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
}

/** One line per entry. Entries are in time order, so a session's addresses are followed in it. */
function eventLines(entries: readonly Entry[]): string[] {
  const lastAddress = new Map<string, string>()
  return entries.map((entry) => {
    const record = asRecord(entry.event)
    if (record === null || Number.isNaN(entry.at)) {
      return `${clock(NaN)} (unreadable) ${safe(JSON.stringify(entry.event))}`
    }
    const type = String(record.type)
    const read = asServed(record)
    if (read) {
      const showAddress = lastAddress.get(entry.source) !== read.address
      lastAddress.set(entry.source, read.address)
      return `${clock(entry.at)} ${entry.label}${type} ${servedFields(read, showAddress)}`
    }
    const fields = Object.entries(record)
      .filter(([key]) => key !== 'type' && key !== 't')
      .map(([key, value]) => `${safe(key)}=${fieldValue(value)}`)
    return [`${clock(entry.at)} ${entry.label}${safe(type)}`, ...fields].join(' ')
  })
}

/**
 * Where the play's t = 0 was on the server's clock, in milliseconds: the least
 * of what each batch says (when it arrived, less how long the page had played
 * when it sent it), since a batch is only ever late. The page's own start is
 * the fallback, and null if it has none: then nothing can be placed.
 */
function zeroOf(timeline: TimelineRow, batches: readonly BatchRow[]): number | null {
  let zero: number | null = null
  for (const batch of batches) {
    if (batch.sentMs === null) continue
    const said = batch.receivedAt.getTime() - batch.sentMs
    if (zero === null || said < zero) zero = said
  }
  return zero ?? timeline.clientStartedAt?.getTime() ?? null
}

/**
 * A timeline in full: what it is, then every event in time order. A play's
 * stream sessions are placed on its clock by the server's alone (the page's
 * clock may be wrong), their events marked `server`.
 */
export function printTimeline(read: TimelineRead): string {
  const { timeline, batches, sessions } = read
  const lines = headerLines(timeline)
  for (const { timeline: session, batches: own } of sessions) {
    const events = own.reduce((total, batch) => total + batch.events.length, 0)
    lines.push(
      `stream session ${session.id}  started ${session.startedAt.toISOString()}  ${plural(own.length, 'batch', 'batches')}, ${plural(events, 'event', 'events')}  ${safe(session.address)}`,
    )
  }
  lines.push('')

  const entries = entriesOf(batches, timeline.id, '', (t) => t)
  const zero = zeroOf(timeline, batches)
  const apart: { id: string; entries: Entry[] }[] = []
  for (const { timeline: session, batches: own } of sessions) {
    if (zero === null) {
      // Nothing places the play on the server's clock: each session keeps its own.
      apart.push({
        id: session.id,
        entries: entriesOf(own, session.id, '', (t) => t),
      })
    } else {
      entries.push(
        ...entriesOf(own, session.id, 'server ', (t) => session.startedAt.getTime() + t - zero),
      )
    }
  }
  const body = eventLines(inOrder(entries))
  if (body.length === 0 && apart.length === 0) body.push('No events.')
  lines.push(...body)
  for (const section of apart) {
    lines.push(
      '',
      `session ${section.id} (on its own clock)`,
      ...eventLines(inOrder(section.entries)),
    )
  }
  return lines.join('\n')
}
