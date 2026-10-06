import { useElementWidth } from '@/lib/use-element-width'

const HEIGHT = 28

/**
 * A trend without axes, for a figure's tile: a quiet line in the muted ink,
 * broken where there is no data, ending in a dot of the accent where the
 * figure is now.
 */
export function Sparkline({ values }: { values: readonly (number | null)[] }) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const points = values.flatMap((value, index) => (value === null ? [] : [{ value, index }]))
  let max = 0
  for (const point of points) max = Math.max(max, point.value)
  const x = (index: number) => 3 + (index / Math.max(1, values.length - 1)) * (width - 6)
  const y = (value: number) => 3 + (1 - (max > 0 ? value / max : 0)) * (HEIGHT - 6)
  const last = points.at(-1)

  return (
    <div ref={ref} style={{ height: HEIGHT }} aria-hidden>
      {width > 0 && points.length > 1 && (
        <svg width={width} height={HEIGHT} className="block overflow-visible">
          <path
            d={points
              .map(
                (point, at) =>
                  // A gap starts the line afresh rather than bridging it.
                  `${at === 0 || points[at - 1]?.index !== point.index - 1 ? 'M' : 'L'}${x(point.index).toFixed(1)},${y(point.value).toFixed(1)}`,
              )
              .join('')}
            fill="none"
            stroke="var(--muted-foreground)"
            strokeOpacity={0.6}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {last && (
            <circle
              cx={x(last.index)}
              cy={y(last.value)}
              r={3}
              fill="var(--chart-1)"
              stroke="var(--card)"
              strokeWidth={2}
            />
          )}
        </svg>
      )}
    </div>
  )
}
