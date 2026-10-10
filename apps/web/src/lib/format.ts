export { formatBytes } from '@dfs/shared'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' })
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** Short, scannable date for lists: "Just now", "12 minutes ago", "3:42 PM", "Yesterday", "Mar 4, 2025". */
export function formatDate(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  const elapsed = now.getTime() - date.getTime()

  if (elapsed >= 0 && elapsed < MINUTE) return 'Just now'
  if (elapsed >= 0 && elapsed < HOUR)
    return relativeFormat.format(-Math.round(elapsed / MINUTE), 'minute')
  if (isSameDay(date, now)) return timeFormat.format(date)

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(date, yesterday)) return 'Yesterday'

  return dateFormat.format(date)
}

/** `formatDate` in the middle of a sentence: "modified yesterday", not "modified Yesterday". */
export function formatDateInSentence(iso: string, now: Date = new Date()): string {
  const text = formatDate(iso, now)
  return text === 'Just now' || text === 'Yesterday' ? text.toLowerCase() : text
}

/** Unambiguous date and time, for tooltips and detail views. */
export function formatFullDate(iso: string): string {
  return fullFormat.format(new Date(iso))
}

/** "1 item", "1,204 items". */
export function formatCount(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`
}

/** A rough time left, for progress: "a few seconds", "45 s", "12 min", "2 h 5 min". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 10) return 'a few seconds'
  if (seconds < 60) return `${Math.round(seconds / 5) * 5} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** A person's initials, for an avatar: “Sam Rivera” → “SR”. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}
