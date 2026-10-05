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
// sit just above them, and round local times below. Pointing at it, or
// focusing it and using the arrow keys, shows every series at that time.

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
const INSET = 4
const TOOLTIP_WIDTH = 200

export function TimeSeriesChart({
  times,
  bucketSeconds,
  lines,
  format,
  label,
  height = 168,
}: {
  times: readonly number[]
  bucketSeconds: number
  lines: readonly ChartLine[]
  format: ValueFormat
  /** What the graph shows, for screen readers. */
  label: string
  height?: number
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)

  const count = times.length
  const first = times[0] ?? 0
  const last = times.at(-1) ?? first
  const plotBottom = height - AXIS_HEIGHT
  let max = 0
  for (const line of lines)
    for (const value of line.values) if (value !== null) max = Math.max(max, value)
  const ticks = valueTicks(max, format)
  const top = ticks.at(-1) ?? 1
  const plotWidth = Math.max(1, width - 2 * INSET)
  const x = (index: number) => INSET + (count <= 1 ? 0 : (index / (count - 1)) * plotWidth)
  const y = (value: number) => PLOT_TOP + (1 - value / top) * (plotBottom - PLOT_TOP)
  const timeX = (time: number) =>
    INSET + (last === first ? 0 : ((time - first) / (last - first)) * plotWidth)
  const area = lines.length === 1

  const pick = (event: PointerEvent<SVGSVGElement>) => {
    if (count === 0) return
    const left = event.currentTarget.getBoundingClientRect().left
    const ratio = (event.clientX - left - INSET) / plotWidth
    setActive(Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1)))))
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

          {timeTicks(first, last, Math.max(2, Math.floor(width / 96))).map((tick) => {
            const at = timeX(tick)
            return (
              <text
                key={tick}
                x={at}
                y={height - 5}
                textAnchor={at < 32 ? 'start' : at > width - 32 ? 'end' : 'middle'}
                className="fill-muted-foreground text-[10px] tabular-nums"
              >
                {formatTick(tick, last - first)}
              </text>
            )
          })}

          {lines.map((line) => {
            const runs = segments(line.values)
            const color = chartColor(line.color)
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
                  run.length === 1 ? (
                    <circle
                      key={run[0]}
                      cx={x(run[0] ?? 0)}
                      cy={y(line.values[run[0] ?? 0] ?? 0)}
                      r={1.5}
                      fill={color}
                    />
                  ) : (
                    <path
                      key={run[0]}
                      d={linePath(run, line.values, x, y)}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ),
                )}
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
                  <circle
                    key={line.key}
                    cx={activeX}
                    cy={y(value)}
                    r={4}
                    fill={chartColor(line.color)}
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
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
            {formatBucket(times[active] ?? 0, bucketSeconds)}
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
                  <span className="shrink-0 font-semibold whitespace-nowrap tabular-nums">
                    {value === null || value === undefined ? '—' : formatValue(value, format)}
                  </span>
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
