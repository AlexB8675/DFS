import type { SortField } from '@dfs/shared'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { usePreferences } from '@/lib/preferences'
import { cn } from '@/lib/utils'
import { listColumns } from './list-layout'

interface ListHeaderProps {
  showLocation: boolean
  /** Search results have a fixed order. */
  sortable: boolean
}

/** Column titles for the list view; clicking one sorts by it. */
export function ListHeader({ showLocation, sortable }: ListHeaderProps) {
  return (
    <div
      className={cn(
        'mx-2 grid h-9 shrink-0 items-center gap-4 border-b px-3 text-xs font-medium text-muted-foreground',
        listColumns(showLocation),
      )}
    >
      <ColumnTitle field="name" sortable={sortable}>
        Name
      </ColumnTitle>
      {showLocation && <span className="hidden lg:block">Location</span>}
      <ColumnTitle field="updatedAt" sortable={sortable} className="hidden sm:flex">
        Modified
      </ColumnTitle>
      <ColumnTitle field="size" sortable={sortable} className="hidden justify-end sm:flex">
        Size
      </ColumnTitle>
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
