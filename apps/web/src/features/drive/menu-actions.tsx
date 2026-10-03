import { Fragment } from 'react'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@/components/ui/dropdown-menu'
import type { MenuAction } from './node-menu'

/** Renders menu actions as context-menu items. */
export function ContextMenuActions({ actions }: { actions: MenuAction[] }) {
  return actions.map((action, index) => (
    <Fragment key={action.key}>
      {action.separated && index > 0 && <ContextMenuSeparator />}
      <ContextMenuItem
        variant={action.destructive ? 'destructive' : 'default'}
        onSelect={action.onSelect}
      >
        <action.icon />
        {action.label}
        {action.shortcut && <ContextMenuShortcut>{action.shortcut}</ContextMenuShortcut>}
      </ContextMenuItem>
    </Fragment>
  ))
}

/** Renders menu actions as dropdown-menu items. */
export function DropdownMenuActions({ actions }: { actions: MenuAction[] }) {
  return actions.map((action, index) => (
    <Fragment key={action.key}>
      {action.separated && index > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem
        variant={action.destructive ? 'destructive' : 'default'}
        onSelect={action.onSelect}
      >
        <action.icon />
        {action.label}
        {action.shortcut && <DropdownMenuShortcut>{action.shortcut}</DropdownMenuShortcut>}
      </DropdownMenuItem>
    </Fragment>
  ))
}
