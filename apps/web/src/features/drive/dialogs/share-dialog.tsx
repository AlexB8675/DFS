import type { DriveNode, ShareLink } from '@dfs/shared'
import { Check, Copy, ExternalLink, ShieldAlert } from 'lucide-react'
import { useActionState, useState } from 'react'
import { toast } from 'sonner'
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
import { EXPIRY_OPTIONS, expiryFromChoice, useCreateShare } from '@/features/shares/api'
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

/** Creates a public share link (§7.5) and shows it once, since only its hash is stored. */
export function ShareDialog({ node, onClose }: ShareDialogProps) {
  const createShare = useCreateShare()
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
        )}
      </DialogContent>
    </Dialog>
  )
}

function CreatedLink({ url, onDone }: { url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      toast.success('Link copied')
    } catch {
      toast.error('Could not copy. Select the link and copy it manually.')
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex gap-2">
        <Input
          readOnly
          value={url}
          aria-label="Share link"
          className="font-mono text-xs"
          onFocus={(event) => {
            event.currentTarget.select()
          }}
        />
        <Button onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="flex gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        Copy it now. DFS only keeps a fingerprint of the link, so it cannot show it again.
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
