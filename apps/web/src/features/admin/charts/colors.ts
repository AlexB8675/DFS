// The colours of the admin's graphs (§16), from the theme's chart and status tokens.

/** Series colours in their fixed order, or a status colour for series that mean trouble. */
export type ChartColor = 1 | 2 | 3 | 4 | 5 | 'warning' | 'serious' | 'critical'

const COLORS: Record<ChartColor, string> = {
  1: 'var(--chart-1)',
  2: 'var(--chart-2)',
  3: 'var(--chart-3)',
  4: 'var(--chart-4)',
  5: 'var(--chart-5)',
  warning: 'var(--status-warning)',
  serious: 'var(--status-serious)',
  critical: 'var(--status-critical)',
}

export function chartColor(color: ChartColor): string {
  return COLORS[color]
}
