import { formatBytes } from '@/lib/format'

// Axes and numbers for the admin's graphs (§16): round tick values in the
// unit shown, time ticks on round local times, and values in plain words.

/**
 * How a graph shows its values. Rates arrive per second; `perMinute` shows
 * them per minute, for things that happen a few times a minute.
 */
export type ValueFormat =
  'bytes' | 'bytesPerSecond' | 'perSecond' | 'perMinute' | 'count' | 'ms' | 'percent'

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const precise = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

function number(value: number): string {
  return Math.abs(value) < 10 ? precise.format(value) : compact.format(value)
}

export function formatValue(value: number, format: ValueFormat): string {
  switch (format) {
    case 'bytes':
      return formatBytes(value)
    case 'bytesPerSecond':
      return `${formatBytes(value)}/s`
    case 'perSecond':
      return `${number(value)}/s`
    case 'perMinute':
      return `${number(value * 60)}/min`
    case 'count':
      return number(value)
    case 'ms':
      if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)} s`
      return `${value < 10 && value > 0 ? value.toFixed(1) : String(Math.round(value))} ms`
    case 'percent':
      return `${value < 0.1 && value > 0 ? (value * 100).toFixed(1) : String(Math.round(value * 100))}%`
  }
}

/**
 * How a series' whole range reads: rates as the total they add up to, the
 * rest as they are.
 */
export function totalFormat(format: ValueFormat): ValueFormat {
  if (format === 'bytesPerSecond') return 'bytes'
  if (format === 'perSecond' || format === 'perMinute') return 'count'
  return format
}

/** The unit ticks are round in: binary multiples for bytes, minutes for per-minute rates. */
function tickUnit(format: ValueFormat, max: number): number {
  if (format === 'bytes' || format === 'bytesPerSecond') {
    let unit = 1
    while (max / unit >= 1024) unit *= 1024
    return unit
  }
  if (format === 'perMinute') return 1 / 60
  if (format === 'ms' && max >= 1000) return 1000
  return 1
}

const EMPTY_TOP: Record<ValueFormat, number> = {
  bytes: 1024,
  bytesPerSecond: 1024,
  perSecond: 1,
  perMinute: 1 / 60,
  count: 1,
  ms: 10,
  percent: 1,
}

function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw))
  const fraction = raw / power
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10
  return nice * power
}

/** Ticks from 0 to just past `max`, at round values of the unit shown: three or four of them. */
export function valueTicks(max: number, format: ValueFormat): number[] {
  // Shares end at 100%; CPU use can pass one core.
  if (format === 'percent' && max <= 1) return [0, 0.5, 1]
  // Nothing yet: a flat line under a top that reads as "little".
  if (!(max > 0)) return [0, EMPTY_TOP[format]]
  const unit = tickUnit(format, max)
  const step = niceStep(max / unit / 3) * unit
  const ticks = [0]
  while ((ticks.at(-1) ?? 0) < max) ticks.push(ticks.length * step)
  return ticks
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Tick spacings, with the months that `month` ones span. */
const SPACINGS = [
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  61 * DAY,
  91 * DAY,
]

/** Ticks on round local times between `first` and `last`, at most `most` of them. */
export function timeTicks(first: number, last: number, most: number): number[] {
  const span = last - first
  const spacing = SPACINGS.find((candidate) => span / candidate <= most) ?? SPACINGS.at(-1) ?? DAY
  const ticks: number[] = []
  const start = new Date(first)
  start.setHours(0, 0, 0, 0)
  if (spacing >= 30 * DAY) {
    const months = Math.round(spacing / (30 * DAY))
    start.setDate(1)
    start.setMonth(start.getMonth() - (start.getMonth() % months))
    for (const date = start; date.getTime() <= last; date.setMonth(date.getMonth() + months)) {
      if (date.getTime() >= first) ticks.push(date.getTime())
    }
  } else if (spacing >= DAY) {
    const days = Math.round(spacing / DAY)
    for (const date = start; date.getTime() <= last; date.setDate(date.getDate() + days)) {
      if (date.getTime() >= first) ticks.push(date.getTime())
    }
  } else {
    for (let tick = start.getTime(); tick <= last; tick += spacing) {
      if (tick >= first) ticks.push(tick)
    }
  }
  return ticks
}

const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayOfMonth = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const month = new Intl.DateTimeFormat(undefined, { month: 'short' })
const monthAndYear = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' })

/** A tick's label: the time, or the day at midnight, or the month on long ranges. */
export function formatTick(time: number, spanMs: number): string {
  const date = new Date(time)
  const midnight = date.getHours() === 0 && date.getMinutes() === 0
  if (spanMs > 60 * DAY)
    return date.getMonth() === 0 ? monthAndYear.format(date) : month.format(date)
  if (spanMs > 2 * DAY || midnight) return dayOfMonth.format(date)
  return timeOfDay.format(date)
}

const bucketTimes = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const bucketDays = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

/** The time a point covers, for its tooltip and table row. */
export function formatBucket(time: number, bucketSeconds: number): string {
  if (bucketSeconds >= 86_400) return bucketDays.format(new Date(time))
  return bucketTimes.formatRange(new Date(time), new Date(time + bucketSeconds * 1000))
}
