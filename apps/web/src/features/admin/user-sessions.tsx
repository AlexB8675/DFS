import type { AdminUser } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { LogOut, MonitorSmartphone } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { errorMessage } from '@/lib/api/client'
import { SessionList } from './access-page'
import { adminSessionsQuery, useSignOutUser } from './api'

/**
 * A user's signed-in sessions, from their page (§9): each can be signed
 * out, or all at once. The owner's are the owner's own.
 */
export function UserSessions({ user, viewerIsOwner }: { user: AdminUser; viewerIsOwner: boolean }) {
  const [open, setOpen] = useState(false)
  const sessions = useQuery({ ...adminSessionsQuery(user.id), enabled: open })
  const signOut = useSignOutUser()
  const protectedOwner = user.isOwner && !viewerIsOwner

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true)
        }}
      >
        <MonitorSmartphone /> Sessions
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{user.displayName}’s sessions</SheetTitle>
            <SheetDescription>
              Where they are signed in. Signing a session out ends it at once; they can sign in
              again.
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4">
            {sessions.data ? (
              <SessionList sessions={sessions.data} />
            ) : (
              <Skeleton className="h-24 rounded-lg" />
            )}
          </div>
          <SheetFooter>
            <Button
              variant="destructive"
              disabled={protectedOwner || signOut.isPending || sessions.data?.length === 0}
              title={protectedOwner ? 'Only the owner can sign the owner out.' : undefined}
              onClick={() => {
                signOut.mutate(user.id, {
                  onSuccess: ({ ended }) => {
                    toast.success(
                      ended === 0
                        ? `${user.displayName} had no other session`
                        : `Signed ${user.displayName} out of ${String(ended)} ${ended === 1 ? 'session' : 'sessions'}`,
                    )
                  },
                  onError: (error) => {
                    toast.error('Couldn’t sign them out', { description: errorMessage(error) })
                  },
                })
              }}
            >
              {signOut.isPending ? <Spinner /> : <LogOut />} Sign out everywhere
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
