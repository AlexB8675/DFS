import type { AppToken } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { Bot, Check, Copy, KeyRound, Plus, Unplug } from 'lucide-react'
import { useState, type SyntheticEvent } from 'react'
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
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrentUser } from '@/features/auth/session'
import { pathQuery } from '@/features/drive/api'
import { FolderBrowser } from '@/features/drive/dialogs/folder-browser'
import { errorMessage } from '@/lib/api/client'
import { agentNote } from './agent-note'
import { appTokensQuery, useMakeAppToken, useRemoveAppToken } from './api'
import { AppTokenUsage } from './app-token-usage'

/**
 * Settings → Apps: the tokens that let an AI agent reach one folder of your
 * drive, and everything below it, and nothing else. A token is shown once, when
 * it is made.
 */
export function AppsCard() {
  const tokens = useQuery(appTokensQuery())
  const remove = useRemoveAppToken()
  const [making, setMaking] = useState(false)
  const [removing, setRemoving] = useState<AppToken | null>(null)

  function removeToken(token: AppToken) {
    remove.mutate(token.id, {
      onSuccess: () => {
        toast.success(`Removed ${token.name}`)
      },
      onError: (error) => {
        toast.error('Couldn’t remove it', { description: errorMessage(error) })
      },
    })
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Apps</CardTitle>
          <CardDescription>
            Let an AI agent work in one folder of your drive. It reaches that folder and what is
            inside it, nothing else.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {tokens.data ? (
            tokens.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">No apps yet.</p>
            ) : (
              <ul className="grid gap-3" aria-label="Apps">
                {tokens.data.map((token) => (
                  <li
                    key={token.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm"
                  >
                    <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate font-medium">{token.name}</span>
                      <span className="grid text-xs text-muted-foreground">
                        <AppTokenUsage token={token} />
                      </span>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={remove.isPending && remove.variables === token.id}
                      onClick={() => {
                        setRemoving(token)
                      }}
                    >
                      <Unplug /> Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : tokens.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(tokens.error)}
            </p>
          ) : (
            <Skeleton className="h-14 rounded-lg" />
          )}
          <div>
            <Button
              variant="outline"
              onClick={() => {
                setMaking(true)
              }}
            >
              <Plus /> Make an app token
            </Button>
          </div>
        </CardContent>
      </Card>

      {making && (
        <MakeDialog
          onClose={() => {
            setMaking(false)
          }}
        />
      )}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent using it loses access at once. You can make another token later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) removeToken(removing)
              }}
            >
              Remove it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** What was made: kept only in this dialog's state, so closing it forgets the token for good. */
interface Made {
  token: string
  folderName: string
  canWrite: boolean
}

function MakeDialog({ onClose }: { onClose: () => void }) {
  const { rootFolderId } = useCurrentUser()
  const make = useMakeAppToken()
  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState(rootFolderId)
  const [canWrite, setCanWrite] = useState(false)
  const [made, setMade] = useState<Made | null>(null)
  const path = useQuery(pathQuery(folderId))
  const current = path.data?.at(-1)

  function submit(event: SyntheticEvent) {
    event.preventDefault()
    if (!current || name.trim() === '') return
    const folderName = current.name
    make.mutate(
      { name: name.trim(), folderId, canWrite },
      {
        onSuccess: (result) => {
          setMade({ token: result.token, folderName, canWrite: result.appToken.canWrite })
          make.reset()
        },
        onError: (error) => {
          toast.error('Couldn’t make it', { description: errorMessage(error) })
        },
      },
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !make.isPending) onClose()
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        // The answer holds the only copy of the token: a stray click or Escape must not lose it.
        onInteractOutside={(event) => {
          if (made) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (made) event.preventDefault()
        }}
      >
        {made ? (
          <Answer made={made} onClose={onClose} />
        ) : (
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Make an app token</DialogTitle>
              <DialogDescription>
                Pick the folder the agent may use. It can also reach every folder inside it.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-2">
              <Label htmlFor="app-token-name">Name</Label>
              <Input
                id="app-token-name"
                value={name}
                maxLength={80}
                placeholder="Notes helper"
                autoComplete="off"
                onChange={(event) => {
                  setName(event.target.value)
                }}
              />
            </div>

            <div className="grid gap-2">
              <span className="text-sm font-medium">Choose folder</span>
              <FolderBrowser folderId={folderId} onFolderChange={setFolderId} />
              <p className="text-sm text-muted-foreground">
                Chosen: <span className="font-medium text-foreground">{current?.name ?? '…'}</span>
              </p>
            </div>

            <fieldset className="grid gap-2">
              <legend className="mb-2 text-sm font-medium">Access</legend>
              <AccessOption
                checked={!canWrite}
                title="Read only"
                detail="It can list and read files, and change nothing."
                onSelect={() => {
                  setCanWrite(false)
                }}
              />
              <AccessOption
                checked={canWrite}
                title="Read and write"
                detail="It can also add, change, move and trash files in that folder."
                onSelect={() => {
                  setCanWrite(true)
                }}
              />
            </fieldset>

            <DialogFooter>
              <Button type="button" variant="outline" disabled={make.isPending} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={make.isPending || !current || name.trim() === ''}>
                <KeyRound /> Make token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function AccessOption({
  checked,
  title,
  detail,
  onSelect,
}: {
  checked: boolean
  title: string
  detail: string
  onSelect: () => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
      <input
        type="radio"
        name="app-token-access"
        className="mt-0.5 accent-primary"
        checked={checked}
        onChange={onSelect}
      />
      <span className="grid gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">{detail}</span>
      </span>
    </label>
  )
}

/** The token, once, and the note to give the agent. */
function Answer({ made, onClose }: { made: Made; onClose: () => void }) {
  const note = agentNote({
    origin: window.location.origin,
    folderName: made.folderName,
    canWrite: made.canWrite,
    token: made.token,
  })

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Your app token</DialogTitle>
        <DialogDescription>
          Copy it now. It is shown only this once, and closing this window hides it for good.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <span className="text-sm font-medium">Token</span>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs break-all">
            {made.token}
          </code>
          <CopyButton text={made.token} what="Token" />
        </div>
      </div>

      <div className="grid gap-2">
        <span className="text-sm font-medium">A note to paste to your agent</span>
        <pre className="rounded-md border bg-muted/40 p-2 font-mono text-xs break-all whitespace-pre-wrap">
          {note}
        </pre>
        <div>
          <CopyButton text={note} what="Note" label="Copy note" />
        </div>
      </div>

      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </div>
  )
}

function CopyButton({
  text,
  what,
  label = 'Copy',
}: {
  text: string
  what: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
      }, 2000)
    } catch {
      toast.error('Couldn’t copy it', { description: `Select the text and copy it by hand.` })
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={`${label}: ${what}`}
      onClick={() => void copy()}
    >
      {copied ? <Check /> : <Copy />} {copied ? 'Copied' : label}
    </Button>
  )
}
