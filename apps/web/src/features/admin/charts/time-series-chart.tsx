import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { useElementWidth } from '@/lib/use-element-width'
import { chartColor, type ChartColor } from './colors'
import {
  formatBucket,
  formatTick,
  formatValue,
  timeTicks,
  valueTicks,
  type ValueFormat,
} from './scales'

// A time-series graph for the admin pages (§16), drawn as SVG: thin lines
// (with a light wash under a lone series) on hairline gridlines whose values
// sit just above them, and round local times below. Each point stands at the
// middle of the time its bucket covers, so the axis reads true: the last one
// may cover less, up to where the figures end. A line breaks where there is
// no data, a lone point shows as a dot, and each line ends in a dot at its
// latest value. Pointing at it, or focusing it and using the arrow keys,
// shows every series at that time.

export interface ChartLine {
  key: string
  label: string
  color: ChartColor
  /** One per time; `null` where there was nothing to show. */
  values: readonly (number | null)[]
}

/** Room above the top gridline for its label, and below the plot for the times. */
const PLOT_TOP = 14
const AXIS_HEIGHT = 20
/** Keeps the end dots inside the drawing. */
const INSET = 6
const TOOLTIP_WIDTH = 200

export function TimeSeriesChart({
  times,
  bucketSeconds,
  until,
  lines,
  format,
  label,
  height = 168,
}: {
  /** Each bucket's start. */
  times: readonly number[]
  bucketSeconds: number
  /** Where the figures end, within the last bucket or at its end. */
  until: number
  lines: readonly ChartLine[]
  format: ValueFormat
  /** What the graph shows, for screen readers. */
  label: string
  height?: number
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)

  const count = times.length
  const bucketMs = bucketSeconds * 1000
  const start = times[0] ?? until - bucketMs
  const end = Math.max(until, start + 1)
  const plotBottom = height - AXIS_HEIGHT
  let max = 0
  for (const line of lines)
    for (const value of line.values) if (value !== null) max = Math.max(max, value)
  const ticks = valueTicks(max, format)
  const top = ticks.at(-1) ?? 1
  const plotWidth = Math.max(1, width - 2 * INSET)
  const timeX = (time: number) => INSET + ((time - start) / (end - start)) * plotWidth
  /** The middle of what a bucket covers: the last may stop at `until`. */
  const x = (index: number) => {
    const time = times[index] ?? start
    return timeX((time + Math.min(time + bucketMs, until)) / 2)
  }
  const y = (value: number) => PLOT_TOP + (1 - value / top) * (plotBottom - PLOT_TOP)
  const area = lines.length === 1

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    if (count === 0) return
    const left = event.currentTarget.getBoundingClientRect().left
    const time = start + ((event.clientX - left - INSET) / plotWidth) * (end - start)
    setActive(Math.min(count - 1, Math.max(0, Math.floor((time - start) / bucketMs))))
  }

  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: (active ?? count) - 1,
      ArrowRight: (active ?? -1) + 1,
      Home: 0,
      End: count - 1,
    }
    if (event.key === 'Escape') {
      setActive(null)
      return
    }
    const next = moves[event.key]
    if (next === undefined || count === 0) return
    event.preventDefault()
    setActive(Math.min(count - 1, Math.max(0, next)))
  }

  const activeX = active === null ? 0 : x(active)
  const tooltipLeft =
    activeX + 12 + TOOLTIP_WIDTH > width ? Math.max(0, activeX - 12 - TOOLTIP_WIDTH) : activeX + 12

  return (
    <div
      ref={ref}
      role="group"
      aria-label={`${label}. Use the arrow keys to read values.`}
      tabIndex={0}
      onKeyDown={step}
      onBlur={() => {
        setActive(null)
      }}
      className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      style={{ height }}
    >
      {width > 0 && (
        <svg
          width={width}
          height={height}
          className="block touch-pan-y overflow-visible select-none"
          aria-hidden
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => {
            setActive(null)
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={0}
                x2={width}
                y1={y(tick)}
                y2={y(tick)}
                stroke="var(--border)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={0}
                y={y(tick) - 4}
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {formatValue(tick, format)}
              </text>
            </g>
          ))}

          {timeTicks(start, end, Math.max(2, Math.floor(width / 96))).map((tick) => {
            const at = timeX(tick)
            return (
              <text
                key={tick}
                x={at}
                y={height - 5}
                textAnchor={at < 32 ? 'start' : at > width - 32 ? 'end' : 'middle'}
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {formatTick(tick, end - start)}
              </text>
            )
          })}

          {lines.map((line) => {
            const runs = segments(line.values)
            const color = chartColor(line.color)
            const latest = runs.at(-1)?.at(-1)
            return (
              <g key={line.key}>
                {area &&
                  runs.map((run) => (
                    <path
                      key={run[0]}
                      d={areaPath(run, line.values, x, y, plotBottom)}
                      fill={color}
                      opacity={0.1}
                    />
                  ))}
                {runs.map((run) =>
                  run.length > 1 ? (
                    <path
                      key={run[0]}
                      d={linePath(run, line.values, x, y)}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ) : null,
                )}
                {/* A point between gaps has no line to show it: it is a dot, as is the latest. */}
                {runs
                  .flatMap((run) => (run.length === 1 ? run : []))
                  .concat(latest !== undefined && runs.at(-1)?.length !== 1 ? [latest] : [])
                  .map((index) => (
                    <Dot key={index} x={x(index)} y={y(line.values[index] ?? 0)} color={color} />
                  ))}
              </g>
            )
          })}

          {active !== null && (
            <g>
              <line
                x1={activeX}
                x2={activeX}
                y1={PLOT_TOP}
                y2={plotBottom}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.5}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              {lines.map((line) => {
                const value = line.values[active]
                return value === null || value === undefined ? null : (
                  <Dot key={line.key} x={activeX} y={y(value)} color={chartColor(line.color)} />
                )
              })}
            </g>
          )}
        </svg>
      )}

      {active !== null && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute top-0 z-10 rounded-md border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
          style={{ left: tooltipLeft, width: TOOLTIP_WIDTH }}
        >
          <p className="mb-1.5 text-muted-foreground">
            {formatBucket(times[active] ?? 0, bucketSeconds, until)}
          </p>
          <ul className="grid gap-1">
            {lines.map((line) => {
              const value = line.values[active]
              return (
                <li key={line.key} className="flex items-center gap-2">
                  <span
                    className="h-0.5 w-3 shrink-0 rounded-full"
                    style={{ background: chartColor(line.color) }}
                    aria-hidden
                  />
                  {value === null || value === undefined ? (
                    <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                      no data
                    </span>
                  ) : (
                    <span className="shrink-0 font-semibold whitespace-nowrap tabular-nums">
                      {formatValue(value, format)}
                    </span>
                  )}
                  <span className="truncate text-muted-foreground">{line.label}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

/** A marker: 8 px of the series' colour in a 2 px ring of the card, so it stands clear of lines. */
function Dot({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <circle
      cx={x}
      cy={y}
      r={4}
      fill={color}
      stroke="var(--card)"
      strokeWidth={4}
      paintOrder="stroke"
    />
  )
}

/** The runs of indexes with values, between gaps. */
function segments(values: readonly (number | null)[]): number[][] {
  const runs: number[][] = []
  let run: number[] = []
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length > 0) runs.push(run)
      run = []
    } else {
      run.push(index)
    }
  })
  if (run.length > 0) runs.push(run)
  return runs
}

function linePath(
  run: readonly number[],
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
): string {
  return run
    .map(
      (index, at) =>
        `${at === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(values[index] ?? 0).toFixed(1)}`,
    )
    .join('')
}

function areaPath(
  run: readonly number[],
  values: readonly (number | null)[],
  x: (index: number) => number,
  y: (value: number) => number,
  baseline: number,
): string {
  const start = run[0] ?? 0
  const end = run.at(-1) ?? start
  return `${linePath(run, values, x, y)}L${x(end).toFixed(1)},${String(baseline)}L${x(start).toFixed(1)},${String(baseline)}Z`
}
