import type { AdminSession, AdminUpload } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { KeyRound, LogOut, XCircle } from 'lucide-react'
import { useState } from 'react'
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
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/lib/api/client'
import { formatBytes, formatDateInSentence, formatFullDate } from '@/lib/format'
import { describeUserAgent } from '@/lib/user-agent'
import { adminSessionsQuery, adminUploadsQuery, useCancelUploadAsAdmin, useEndSession } from './api'
import { AllClear, Section } from './section'
import { ShareLinks, type Confirmation } from './share-links'

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
        <ShareLinks onConfirm={setConfirming} />
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
              <span title={formatFullDate(session.createdAt)}>
                {formatDateInSentence(session.createdAt)}
              </span>
              {session.lastSeenAt && (
                <>
                  {' · active '}
                  <span title={formatFullDate(session.lastSeenAt)}>
                    {formatDateInSentence(session.lastSeenAt)}
                  </span>
                </>
              )}
            </span>
          </span>
          {/* The owner's are the owner's to end, and this one is signed out from the menu. */}
          {session.canSignOut && (
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
        <AllClear>Nothing is uploading.</AllClear>
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
          · started {formatDateInSentence(upload.createdAt)}
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
