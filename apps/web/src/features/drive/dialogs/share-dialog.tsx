import type { DriveNode, ShareLink } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { useActionState, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  EXPIRY_OPTIONS,
  expiryFromChoice,
  linkTerms,
  sharesQuery,
  shareStatus,
  useCreateShare,
} from '@/features/shares/api'
import { LinkBox } from '@/features/shares/link-box'
import { errorMessage } from '@/lib/api/client'
import { formText } from '@/lib/form-data'

interface ShareDialogProps {
  node: DriveNode
  onClose: () => void
}

interface FormState {
  link: ShareLink | null
  error: string | null
}

/**
 * Creates a public share link (§7.5), below the item's working links made
 * before, to copy again: where someone who lost one looks first.
 */
export function ShareDialog({ node, onClose }: ShareDialogProps) {
  const createShare = useCreateShare()
  const made = useQuery(sharesQuery).data?.items ?? []
  const working = made.filter(
    (link) => link.nodeId === node.id && link.url !== null && shareStatus(link) === 'active',
  )
  const [expiry, setExpiry] = useState<string>('7')
  const [state, submit, pending] = useActionState(
    async (_previous: FormState, formData: FormData): Promise<FormState> => {
      const password = formText(formData, 'password')
      const limit = formText(formData, 'maxDownloads')
      if (password && password.length < 4)
        return { link: null, error: 'Use at least 4 characters for the password.' }
      try {
        const link = await createShare.mutateAsync({
          nodeId: node.id,
          expiresAt: expiryFromChoice(expiry),
          password: password || null,
          maxDownloads: limit ? Number(limit) : null,
        })
        return { link, error: null }
      } catch (error) {
        return { link: null, error: errorMessage(error) }
      }
    },
    { link: null, error: null },
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share “{node.name}”</DialogTitle>
          <DialogDescription>
            Anyone with the link can{' '}
            {node.kind === 'folder' ? 'browse and download this folder' : 'download this file'}.
          </DialogDescription>
        </DialogHeader>

        {state.link?.url ? (
          <CreatedLink url={state.link.url} onDone={onClose} />
        ) : (
          <>
            {/* Outside the form: Enter in a link's box doesn't make a new one. */}
            {working.length > 0 && (
              <div className="grid gap-3 border-b pb-4">
                <p className="text-sm font-medium">
                  {working.length === 1 ? 'Its link' : 'Its links'}
                </p>
                {working.map((link) => (
                  <div key={link.id} className="grid gap-1.5">
                    <LinkBox url={link.url ?? ''} />
                    <p className="text-xs text-muted-foreground">{linkTerms(link)}</p>
                  </div>
                ))}
                <p className="text-sm font-medium">Or make a new one</p>
              </div>
            )}
            <form action={submit} className="grid gap-4">
              <div className="grid gap-2">
                <Label id="expiry-label">Link expires</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  spacing={0}
                  value={expiry}
                  aria-labelledby="expiry-label"
                  onValueChange={(value) => {
                    if (value) setExpiry(value)
                  }}
                >
                  {EXPIRY_OPTIONS.map((option) => (
                    <ToggleGroupItem key={option.value} value={option.value} className="flex-1">
                      {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              {/* The boxes line up when a label wraps onto two lines, as on a phone. */}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid content-end gap-2">
                  <Label htmlFor="share-password">Password (optional)</Label>
                  <Input
                    id="share-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                  />
                </div>
                <div className="grid content-end gap-2">
                  <Label htmlFor="share-limit">Download limit (optional)</Label>
                  <Input
                    id="share-limit"
                    name="maxDownloads"
                    type="number"
                    min={1}
                    inputMode="numeric"
                  />
                </div>
              </div>
              {state.error && (
                <p role="alert" className="text-sm text-destructive">
                  {state.error}
                </p>
              )}
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <Button type="submit" disabled={pending}>
                  {pending && <Spinner />} Create link
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function CreatedLink({ url, onDone }: { url: string; onDone: () => void }) {
  return (
    <div className="grid gap-4">
      <LinkBox url={url} />
      <p className="text-sm text-muted-foreground">
        Shared links keeps it, to copy again whenever you like.
      </p>
      <DialogFooter>
        <Button variant="outline" asChild>
          <a href={url} target="_blank" rel="noreferrer">
            <ExternalLink /> Open link
          </a>
        </Button>
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  )
}
