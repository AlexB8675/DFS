import type { SortField } from '@dfs/shared'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { usePreferences } from '@/lib/preferences'
import { cn } from '@/lib/utils'
import type { ListLayout } from './list-layout'

interface ListHeaderProps {
  layout: ListLayout
  /** Search results have a fixed order. */
  sortable: boolean
}

/** Column titles for the list view; clicking one sorts by it. */
export function ListHeader({ layout, sortable }: ListHeaderProps) {
  return (
    <div
      className={cn(
        'mx-2 grid h-9 shrink-0 items-center gap-4 border-b px-3 text-xs font-medium text-muted-foreground',
        layout.columns,
      )}
    >
      <ColumnTitle field="name" sortable={sortable}>
        Name
      </ColumnTitle>
      {layout.location === 'column' && <span>Location</span>}
      {layout.details && (
        <>
          <ColumnTitle field="updatedAt" sortable={sortable}>
            Modified
          </ColumnTitle>
          <ColumnTitle field="size" sortable={sortable} className="justify-end">
            Size
          </ColumnTitle>
        </>
      )}
      <span className="sr-only">Sync status</span>
    </div>
  )
}

interface ColumnTitleProps {
  field: SortField
  sortable: boolean
  className?: string
  children: string
}

function ColumnTitle({ field, sortable, className, children }: ColumnTitleProps) {
  const sortField = usePreferences((state) => state.sortField)
  const sortOrder = usePreferences((state) => state.sortOrder)
  const sortBy = usePreferences((state) => state.sortBy)

  if (!sortable) return <span className={cn('flex', className)}>{children}</span>

  const active = sortField === field
  const Arrow = sortOrder === 'asc' ? ArrowUp : ArrowDown
  return (
    <button
      type="button"
      className={cn(
        'flex items-center gap-1 transition-colors hover:text-foreground',
        active && 'text-foreground',
        className,
      )}
      aria-label={`Sort by ${children.toLowerCase()}`}
      onClick={() => {
        sortBy(field)
      }}
    >
      {children}
      {active && <Arrow className="size-3.5" aria-hidden />}
    </button>
  )
}
