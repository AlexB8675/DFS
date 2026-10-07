import type { AdminShare, AdminShareOwner } from '@dfs/shared'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ChevronRight, FolderOpen, KeyRound, Link2Off, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { NodeIcon } from '@/components/node-icon'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { formatDate, formatFullDate, initials } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  adminShareOwnersQuery,
  adminSharesQuery,
  useDeleteShareAsAdmin,
  type ShareFilter,
} from './api'
import { AllClear, Section } from './section'

/** An action that can't be undone, waiting for the admin to confirm it. */
export interface Confirmation {
  title: string
  description: string
  action: string
  run: () => Promise<unknown>
  done: string
}

const SHARE_STATES: Record<AdminShare['state'], string> = {
  active: 'Active',
  expired: 'Expired',
  used_up: 'Used up',
  version_deleted: 'Version deleted',
}

/** Groups open at first when there are this few, or when a search narrowed them. */
const OPEN_UP_TO = 3

/**
 * Admin → Access: every user's share links, by owner, each group opening on
 * that user's links, newest first, with where the item is in their drive.
 * A search finds links by their item's name, its folders or its owner.
 */
export function ShareLinks({ onConfirm }: { onConfirm: (confirmation: Confirmation) => void }) {
  const [active, setActive] = useState(true)
  const [draft, setDraft] = useState('')
  const [q, setQ] = useState('')
  // Searches once typing pauses, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(draft.trim())
    }, 300)
    return () => {
      clearTimeout(timer)
    }
  }, [draft])
  const filter: ShareFilter = { active, q }
  const owners = useQuery(adminShareOwnersQuery(filter))
  // Groups the admin opened or closed; the others follow `OPEN_UP_TO`.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map())
  const openByDefault = q !== '' || (owners.data?.length ?? 0) <= OPEN_UP_TO

  return (
    <Section
      title="Share links"
      description="Everyone’s links, by owner. Their addresses aren’t shown: only their owners ever saw them."
      action={
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={active ? 'active' : 'all'}
          aria-label="Which links"
          onValueChange={(value) => {
            if (value) setActive(value === 'active')
          }}
        >
          <ToggleGroupItem value="active" className="px-2.5">
            Working
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className="px-2.5">
            All
          </ToggleGroupItem>
        </ToggleGroup>
      }
    >
      <div className="grid gap-3">
        <div className="relative sm:w-80">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
            placeholder="Find a file, folder or person"
            aria-label="Find share links"
            className="pl-8"
          />
        </div>
        {!owners.data ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : owners.data.length === 0 ? (
          <AllClear>
            {q !== ''
              ? 'No link matches.'
              : active
                ? 'No link is working.'
                : 'No one has shared anything.'}
          </AllClear>
        ) : (
          <ul className="grid gap-1.5" aria-label="Share links by owner">
            {owners.data.map((owner) => (
              <OwnerGroup
                key={owner.ownerId}
                owner={owner}
                filter={filter}
                open={toggled.get(owner.ownerId) ?? openByDefault}
                onToggle={(open) => {
                  setToggled((current) => new Map(current).set(owner.ownerId, open))
                }}
                onConfirm={onConfirm}
              />
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

function OwnerGroup({
  owner,
  filter,
  open,
  onToggle,
  onConfirm,
}: {
  owner: AdminShareOwner
  filter: ShareFilter
  open: boolean
  onToggle: (open: boolean) => void
  onConfirm: (confirmation: Confirmation) => void
}) {
  const panelId = `share-owner-${owner.ownerId}`
  return (
    <li className="rounded-lg border border-border/60">
      <div className="flex items-center gap-2 pr-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => {
            onToggle(!open)
          }}
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform motion-spring',
              open && 'rotate-90',
            )}
            aria-hidden
          />
          <Avatar className="size-6">
            <AvatarFallback className="bg-primary/20 text-[0.625rem] font-medium text-primary">
              {initials(owner.ownerName)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 truncate font-medium">{owner.ownerName}</span>
          <span className="hidden truncate text-muted-foreground sm:inline">
            @{owner.ownerUsername}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {counts(owner, filter.active)}
          </span>
        </button>
        <Button variant="ghost" size="icon-sm" asChild>
          <Link
            to={`/admin/users/${owner.ownerId}`}
            aria-label={`Browse ${owner.ownerName}’s files`}
            title="Browse their files"
          >
            <FolderOpen />
          </Link>
        </Button>
      </div>
      {open && (
        <div id={panelId} className="border-t border-border/60 px-2.5 pt-1 pb-2">
          <OwnerLinks owner={owner} filter={filter} onConfirm={onConfirm} />
        </div>
      )}
    </li>
  )
}

/** “2 working of 5 links”, or “2 links” when only working ones are listed. */
function counts(owner: AdminShareOwner, active: boolean): string {
  const noun = (count: number) => (count === 1 ? 'link' : 'links')
  if (active) return `${String(owner.working)} ${noun(owner.working)}`
  return `${String(owner.working)} working of ${String(owner.links)} ${noun(owner.links)}`
}

function OwnerLinks({
  owner,
  filter,
  onConfirm,
}: {
  owner: AdminShareOwner
  filter: ShareFilter
  onConfirm: (confirmation: Confirmation) => void
}) {
  const shares = useInfiniteQuery(adminSharesQuery(filter, owner.ownerId))
  const remove = useDeleteShareAsAdmin()
  const items = shares.data?.pages.flatMap((page) => page.items) ?? []
  if (!shares.data) return <Skeleton className="mt-1 h-16 rounded-lg" />

  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1.5 font-medium">Shared</th>
              <th className="py-1.5 pl-4 font-medium">State</th>
              <th className="py-1.5 pl-4 text-right font-medium">Downloads</th>
              <th className="py-1.5 pl-4 font-medium">Created</th>
              <th className="w-10 py-1.5" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((share) => (
              <tr key={share.id} className="border-t border-border/60">
                <td className="max-w-80 py-1.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <NodeIcon
                      node={{ kind: share.nodeKind, name: share.nodeName, mimeType: null }}
                      className="size-4 shrink-0"
                    />
                    <span className="grid min-w-0">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {share.parentId ? (
                          <Link
                            to={`/admin/users/${share.ownerId}/folders/${share.parentId}`}
                            className="truncate font-medium underline-offset-4 hover:underline"
                            title={`Open ${share.path || 'My Drive'} in the metadata browser`}
                          >
                            {share.nodeName}
                          </Link>
                        ) : (
                          <span className="truncate font-medium">{share.nodeName}</span>
                        )}
                        {share.hasPassword && (
                          <KeyRound
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-label="Needs a password"
                          />
                        )}
                        {share.version === 'earlier' && (
                          <span
                            className="shrink-0 text-xs text-muted-foreground"
                            title="The file was replaced since; the link shares the version it was made for."
                          >
                            earlier version
                          </span>
                        )}
                      </span>
                      <span
                        className="truncate text-xs text-muted-foreground"
                        title={share.path || 'My Drive'}
                      >
                        {share.path ? `My Drive / ${share.path}` : 'My Drive'}
                      </span>
                    </span>
                  </span>
                </td>
                <td className="py-1.5 pl-4 whitespace-nowrap text-muted-foreground">
                  {SHARE_STATES[share.state]}
                  {share.state === 'active' && share.expiresAt && (
                    <span title={formatFullDate(share.expiresAt)}>
                      {' '}
                      · until {formatDate(share.expiresAt)}
                    </span>
                  )}
                </td>
                <td className="py-1.5 pl-4 text-right whitespace-nowrap tabular-nums">
                  {share.downloadCount}
                  {share.maxDownloads !== null && ` of ${String(share.maxDownloads)}`}
                </td>
                <td
                  className="py-1.5 pl-4 whitespace-nowrap text-muted-foreground"
                  title={formatFullDate(share.createdAt)}
                >
                  {formatDate(share.createdAt)}
                </td>
                <td className="py-1 pl-2 text-right">
                  {share.state === 'active' && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${share.ownerName}’s link to ${share.nodeName}`}
                      title="Delete the link"
                      onClick={() => {
                        onConfirm({
                          title: `Delete ${share.ownerName}’s link?`,
                          description: `The link to “${share.nodeName}” stops working for anyone who has it, and goes from ${share.ownerName}’s links.`,
                          action: 'Delete it',
                          run: () => remove.mutateAsync(share.id),
                          done: `Deleted the link to ${share.nodeName}`,
                        })
                      }}
                    >
                      <Link2Off />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shares.hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-center"
          disabled={shares.isFetchingNextPage}
          onClick={() => void shares.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  )
}
