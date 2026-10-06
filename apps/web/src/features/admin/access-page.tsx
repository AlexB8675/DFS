import type { AdminSession, AdminShare, AdminUpload } from '@dfs/shared'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { CircleCheck, KeyRound, LogOut, Link2Off, XCircle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { errorMessage } from '@/lib/api/client'
import { formatBytes, formatDate, formatFullDate } from '@/lib/format'
import { describeUserAgent } from '@/lib/user-agent'
import {
  adminSessionsQuery,
  adminSharesQuery,
  adminUploadsQuery,
  useCancelUploadAsAdmin,
  useEndSession,
  useRevokeShareAsAdmin,
} from './api'

/** An action that can't be undone, waiting for the admin to confirm it. */
interface Confirmation {
  title: string
  description: string
  action: string
  run: () => Promise<unknown>
  done: string
}

/**
 * `/admin/access`: who is signed in, every share link and the uploads under
 * way, each of which an admin can end (§9). Links show no token (D4).
 */
export function AccessPage() {
  const [confirming, setConfirming] = useState<Confirmation | null>(null)

  const confirm = async () => {
    if (!confirming) return
    const { run, done } = confirming
    setConfirming(null)
    try {
      await run()
      toast.success(done)
    } catch (error) {
      toast.error('Couldn’t do that', { description: errorMessage(error) })
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-6 p-4 sm:p-6">
        <Sessions />
        <Shares onConfirm={setConfirming} />
        <Uploads onConfirm={setConfirming} />
      </div>
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirm()}>
              {confirming?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/** Every signed-in session, most recently used first. */
function Sessions() {
  const sessions = useQuery(adminSessionsQuery())
  return (
    <Section
      title="Signed in"
      description="Sessions that haven’t ended, most recently used first. Signing one out ends it at once; the person can sign in again."
    >
      {sessions.data ? (
        <SessionList sessions={sessions.data} showUser />
      ) : (
        <Skeleton className="h-24 rounded-lg" />
      )}
    </Section>
  )
}

/** A list of sessions, each with Sign out; shared with a user's page. */
export function SessionList({
  sessions,
  showUser = false,
}: {
  sessions: AdminSession[]
  showUser?: boolean
}) {
  const end = useEndSession()
  if (sessions.length === 0) {
    return <p className="text-sm text-muted-foreground">No one is signed in.</p>
  }
  return (
    <ul className="grid gap-2">
      {sessions.map((session) => (
        <li key={session.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              {showUser && (
                <Link
                  to={`/admin/users/${session.userId}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {session.userName}
                </Link>
              )}
              <span className={showUser ? 'text-muted-foreground' : 'font-medium'}>
                {describeUserAgent(session.userAgent)}
              </span>
              {session.current && <Badge variant="secondary">This session</Badge>}
              {session.limited && (
                <Badge variant="outline" title="Signed in with a temporary password">
                  <KeyRound /> Choosing a password
                </Badge>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {session.ip ?? 'unknown address'} · signed in{' '}
              <span title={formatFullDate(session.createdAt)}>{formatDate(session.createdAt)}</span>
              {session.lastSeenAt && (
                <>
                  {' · active '}
                  <span title={formatFullDate(session.lastSeenAt)}>
                    {formatDate(session.lastSeenAt)}
                  </span>
                </>
              )}
            </span>
          </span>
          {!session.current && (
            <Button
              variant="outline"
              size="sm"
              disabled={end.isPending && end.variables === session.key}
              onClick={() => {
                end.mutate(session.key, {
                  onSuccess: () => {
                    toast.success(
                      `Signed ${session.userName} out of ${describeUserAgent(session.userAgent)}`,
                    )
                  },
                  onError: (error) => {
                    toast.error('Couldn’t sign that session out', {
                      description: errorMessage(error),
                    })
                  },
                })
              }}
            >
              <LogOut /> Sign out
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}

const SHARE_STATES: Record<AdminShare['state'], string> = {
  active: 'Active',
  expired: 'Expired',
  used_up: 'Used up',
  revoked: 'Turned off',
}

function Shares({ onConfirm }: { onConfirm: (confirmation: Confirmation) => void }) {
  const [active, setActive] = useState(true)
  const shares = useInfiniteQuery(adminSharesQuery(active))
  const revoke = useRevokeShareAsAdmin()
  const items = shares.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <Section
      title="Share links"
      description="Everyone’s links, newest first. Their addresses aren’t shown: only their owners ever saw them."
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
      {!shares.data ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : items.length === 0 ? (
        <Quiet>{active ? 'No link is working.' : 'No one has shared anything.'}</Quiet>
      ) : (
        <div className="grid gap-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Shared</th>
                  <th className="pb-2 pl-4 font-medium">Owner</th>
                  <th className="pb-2 pl-4 font-medium">State</th>
                  <th className="pb-2 pl-4 text-right font-medium">Downloads</th>
                  <th className="pb-2 pl-4 font-medium">Created</th>
                  <th className="w-10 pb-2" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {items.map((share) => (
                  <tr key={share.id} className="border-t border-border/60">
                    <td className="max-w-64 py-1.5">
                      <span className="flex items-center gap-1.5">
                        {share.parentId ? (
                          <Link
                            to={`/admin/users/${share.ownerId}/folders/${share.parentId}`}
                            className="truncate font-medium underline-offset-4 hover:underline"
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
                      </span>
                    </td>
                    <td className="py-1.5 pl-4 whitespace-nowrap">{share.ownerName}</td>
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
                          aria-label={`Turn off ${share.ownerName}’s link to ${share.nodeName}`}
                          title="Turn the link off"
                          onClick={() => {
                            onConfirm({
                              title: `Turn off ${share.ownerName}’s link?`,
                              description: `The link to “${share.nodeName}” stops working for anyone who has it, for good. ${share.ownerName} sees it turned off.`,
                              action: 'Turn it off',
                              run: () => revoke.mutateAsync(share.id),
                              done: `Turned off the link to ${share.nodeName}`,
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
      )}
    </Section>
  )
}

function Uploads({ onConfirm }: { onConfirm: (confirmation: Confirmation) => void }) {
  const uploads = useQuery(adminUploadsQuery)
  const cancel = useCancelUploadAsAdmin()

  return (
    <Section
      title="Uploads under way"
      description="Files still receiving their parts. An upload not finished within a day is given up on its own."
    >
      {!uploads.data ? (
        <Skeleton className="h-16 rounded-lg" />
      ) : uploads.data.length === 0 ? (
        <Quiet>Nothing is uploading.</Quiet>
      ) : (
        <ul className="grid gap-3">
          {uploads.data.map((upload) => (
            <UploadRow
              key={upload.id}
              upload={upload}
              onCancel={() => {
                onConfirm({
                  title: `Give up ${upload.userName}’s upload?`,
                  description: `“${upload.fileName}” stops uploading and what arrived of it is deleted. ${upload.userName} would have to upload it again.`,
                  action: 'Give it up',
                  run: () => cancel.mutateAsync(upload.id),
                  done: `Gave up the upload of ${upload.fileName}`,
                })
              }}
            />
          ))}
        </ul>
      )}
    </Section>
  )
}

function UploadRow({ upload, onCancel }: { upload: AdminUpload; onCancel: () => void }) {
  const ratio = upload.sizeBytes === 0 ? 1 : upload.receivedBytes / upload.sizeBytes
  return (
    <li className="grid gap-1.5 text-sm">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {upload.parentId ? (
          <Link
            to={`/admin/users/${upload.userId}/folders/${upload.parentId}`}
            className="truncate font-medium underline-offset-4 hover:underline"
          >
            {upload.fileName}
          </Link>
        ) : (
          <span className="truncate font-medium">{upload.fileName}</span>
        )}
        <span className="text-muted-foreground">
          {upload.userName} · {formatBytes(upload.receivedBytes)} of {formatBytes(upload.sizeBytes)}{' '}
          · started {formatDate(upload.createdAt)}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onCancel}>
          <XCircle /> Give up
        </Button>
      </span>
      <Progress
        value={Math.min(100, ratio * 100)}
        aria-label={`${upload.fileName} received`}
        className="h-1.5"
      />
    </li>
  )
}

function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <CircleCheck className="size-4 text-status-good" aria-hidden /> {children}
    </p>
  )
}
