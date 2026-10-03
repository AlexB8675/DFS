import { Link2, Plus, Trash2, type LucideIcon } from 'lucide-react'
import { NavLink, useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { useCurrentUser } from '@/features/auth/session'
import { DropdownMenuActions } from '@/features/drive/menu-actions'
import { useNodeMenu } from '@/features/drive/node-menu'
import { FolderTree } from '@/features/tree/folder-tree'
import { cn } from '@/lib/utils'
import { QuotaMeter } from './quota-meter'

interface SidebarProps {
  /** Called after a link is followed, to close the mobile drawer. */
  onNavigate?: () => void
}

export function Sidebar({ onNavigate }: SidebarProps) {
  return (
    <div className="flex h-full flex-col gap-3 bg-sidebar p-3 text-sidebar-foreground">
      <NewMenu />
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-1">
        {/* A plain scroller: Radix ScrollArea's table layout defeats text truncation. */}
        <div className="-mx-1 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 py-0.5">
          <FolderTree onNavigate={onNavigate} />
        </div>
        <Separator className="my-1" />
        <SidebarLink to="/shared" icon={Link2} onNavigate={onNavigate}>
          Shared links
        </SidebarLink>
        <SidebarLink to="/trash" icon={Trash2} onNavigate={onNavigate}>
          Trash
        </SidebarLink>
      </nav>
      <QuotaMeter onNavigate={onNavigate} />
    </div>
  )
}

/** "New" creates folders and uploads into the folder being viewed (My Drive elsewhere). */
function NewMenu() {
  const { folderId } = useParams()
  const { rootFolderId } = useCurrentUser()
  const actions = useNodeMenu([], folderId ?? rootFolderId)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="lg" className="w-fit gap-2 px-4 shadow-sm">
          <Plus /> New
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuActions actions={actions} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface SidebarLinkProps {
  to: string
  icon: LucideIcon
  onNavigate: (() => void) | undefined
  children: string
}

function SidebarLink({ to, icon: Icon, onNavigate, children }: SidebarLinkProps) {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors outline-none',
          'hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
        )
      }
    >
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      {children}
    </NavLink>
  )
}
