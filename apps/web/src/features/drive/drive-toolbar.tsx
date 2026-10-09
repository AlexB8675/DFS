import type { DriveNode, SortField } from '@dfs/shared'
import { ArrowUpDown, Ellipsis, LayoutGrid, List, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { usePreferences, type ViewMode } from '@/lib/preferences'
import { cn } from '@/lib/utils'
import { DropdownMenuActions } from './menu-actions'
import { useNodeMenu } from './node-menu'
import { useSelection } from './selection'

interface DriveToolbarProps {
  /** Breadcrumbs or a page title. */
  title: ReactNode
  nodes: DriveNode[]
  sortable?: boolean
}

/** On a phone, the selection's first actions as buttons; the rest go in a menu. */
const PHONE_ACTIONS = 3

/**
 * Title on the left; selection actions, or sort and view controls, on the
 * right. On a phone, a selection's actions take the whole bar.
 */
export function DriveToolbar({ title, nodes, sortable = true }: DriveToolbarProps) {
  const selected = useSelection((state) => state.selected)
  const targets = nodes.filter((node) => selected.has(node.id))

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b px-3 sm:px-4">
      <div className={cn('min-w-0 flex-1', targets.length > 0 && 'max-sm:hidden')}>{title}</div>
      {targets.length > 0 ? (
        <SelectionActions targets={targets} />
      ) : (
        <ViewControls sortable={sortable} />
      )}
    </div>
  )
}

function SelectionActions({ targets }: { targets: DriveNode[] }) {
  const clear = useSelection((state) => state.clear)
  const actions = useNodeMenu(targets, null).filter((action) => action.key !== 'open')

  const overflow = actions.slice(PHONE_ACTIONS)

  return (
    <div className="flex animate-in items-center gap-1 duration-150 ease-smooth fade-in-0 max-sm:flex-1">
      <span className="mr-1 text-sm whitespace-nowrap text-muted-foreground max-sm:flex-1">
        {targets.length} selected
      </span>
      {actions.map((action, index) => (
        <Tooltip key={action.key}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={action.label}
              className={cn(
                action.destructive && 'text-destructive hover:text-destructive',
                index >= PHONE_ACTIONS && 'max-sm:hidden',
              )}
              onClick={action.onSelect}
            >
              <action.icon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{action.label}</TooltipContent>
        </Tooltip>
      ))}
      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More actions" className="sm:hidden">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuActions actions={overflow} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Separator orientation="vertical" className="mx-1 h-5" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Clear selection" onClick={clear}>
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Clear selection (Esc)</TooltipContent>
      </Tooltip>
    </div>
  )
}

const SORT_LABELS: Record<SortField, string> = { name: 'Name', updatedAt: 'Modified', size: 'Size' }

function ViewControls({ sortable }: { sortable: boolean }) {
  const viewMode = usePreferences((state) => state.viewMode)
  const setViewMode = usePreferences((state) => state.setViewMode)
  const sortField = usePreferences((state) => state.sortField)
  const sortOrder = usePreferences((state) => state.sortOrder)
  const sortBy = usePreferences((state) => state.sortBy)

  return (
    <div className="flex animate-in items-center gap-2 duration-150 ease-smooth fade-in-0">
      {sortable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="text-muted-foreground">
              <ArrowUpDown />
              <span className="hidden sm:inline">{SORT_LABELS[sortField]}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sortField}
              onValueChange={(value) => {
                if (value !== sortField) sortBy(value as SortField)
              }}
            >
              {Object.entries(SORT_LABELS).map(([field, label]) => (
                <DropdownMenuRadioItem key={field} value={field}>
                  {label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={sortOrder}
              onValueChange={(value) => {
                if (value !== sortOrder) sortBy(sortField)
              }}
            >
              <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Folders are always listed first.
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={viewMode}
        aria-label="View"
        onValueChange={(value) => {
          if (value) setViewMode(value as ViewMode)
        }}
      >
        <ToggleGroupItem value="list" aria-label="List view">
          <List />
        </ToggleGroupItem>
        <ToggleGroupItem value="grid" aria-label="Grid view">
          <LayoutGrid />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}
