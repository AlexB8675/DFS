import { metricRangeSchema } from '@dfs/shared'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { usePreferences } from '@/lib/preferences'
import { RANGES } from '../metrics'

/** The time range every graph below it shows; remembered in this browser. */
export function RangePicker() {
  const range = usePreferences((state) => state.metricRange)
  const setRange = usePreferences((state) => state.setMetricRange)

  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={0}
      value={range}
      aria-label="Time range"
      onValueChange={(next) => {
        const parsed = metricRangeSchema.safeParse(next)
        if (parsed.success) setRange(parsed.data)
      }}
    >
      {RANGES.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="px-2.5 tabular-nums">
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
