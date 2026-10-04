const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

/** Formats a byte count with binary multiples, e.g. `1.5 GB`. */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit] ?? 'B'}`
}

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
