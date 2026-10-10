import type { ShareLink, UpdateShareInput } from '@dfs/shared'
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
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { errorMessage } from '@/lib/api/client'
import { formatFullDate } from '@/lib/format'
import { formText } from '@/lib/form-data'
import { EXPIRY_OPTIONS, expiryFromChoice, NOT_KEPT, useUpdateShare } from './api'
import { LinkBox } from './link-box'

interface FormState {
  error: string | null
}

/** Changes a link's expiry, password and download limit (`PATCH /shares/:id`). */
export function EditShareDialog({ link, onClose }: { link: ShareLink; onClose: () => void }) {
  const update = useUpdateShare()
  const [expiry, setExpiry] = useState('keep')
  const [requirePassword, setRequirePassword] = useState(link.hasPassword)

  const [state, submit, pending] = useActionState(
    async (_previous: FormState, formData: FormData): Promise<FormState> => {
      const changes: UpdateShareInput = {}
      if (expiry !== 'keep') changes.expiresAt = expiryFromChoice(expiry)

      const password = formText(formData, 'password')
      if (!requirePassword && link.hasPassword) changes.password = null
      if (requirePassword && password) {
        if (password.length < 4) return { error: 'Use at least 4 characters for the password.' }
        changes.password = password
      }
      if (requirePassword && !link.hasPassword && !password) {
        return { error: 'Enter a password, or turn the password off.' }
      }

      const limit = formText(formData, 'maxDownloads').trim()
      const maxDownloads = limit ? Number(limit) : null
      if (maxDownloads !== null && (!Number.isInteger(maxDownloads) || maxDownloads < 1)) {
        return { error: 'The download limit must be a whole number above 0.' }
      }
      if (maxDownloads !== link.maxDownloads) changes.maxDownloads = maxDownloads

      try {
        if (Object.keys(changes).length > 0) await update.mutateAsync({ id: link.id, changes })
        toast.success(`Updated the link to “${link.nodeName}”`)
        onClose()
        return { error: null }
      } catch (error) {
        return { error: errorMessage(error) }
      }
    },
    { error: null },
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form action={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>Edit link to “{link.nodeName}”</DialogTitle>
            <DialogDescription>
              The link itself stays the same; people who have it keep using it.
            </DialogDescription>
          </DialogHeader>

          {link.url ? (
            <LinkBox url={link.url} />
          ) : (
            <p className="text-sm text-muted-foreground">{NOT_KEPT}</p>
          )}

          <div className="grid gap-2">
            <Label id="edit-expiry-label">Expires</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              className="w-full"
              value={expiry}
              aria-labelledby="edit-expiry-label"
              onValueChange={(value) => {
                if (value) setExpiry(value)
              }}
            >
              <ToggleGroupItem value="keep" className="flex-auto">
                Keep
              </ToggleGroupItem>
              {EXPIRY_OPTIONS.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value} className="flex-auto">
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              {link.expiresAt
                ? `Now: until ${formatFullDate(link.expiresAt)}`
                : 'Now: never expires'}
            </p>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="edit-require-password">Require a password</Label>
              <Switch
                id="edit-require-password"
                checked={requirePassword}
                onCheckedChange={setRequirePassword}
              />
            </div>
            {requirePassword && (
              <Input
                name="password"
                type="password"
                autoComplete="new-password"
                aria-label="Password"
                placeholder={
                  link.hasPassword ? 'New password (leave empty to keep it)' : 'Password'
                }
                className="animate-in fade-in-0 slide-in-from-top-1 motion-spring"
              />
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="edit-limit">Download limit</Label>
            <Input
              id="edit-limit"
              name="maxDownloads"
              type="number"
              min={1}
              inputMode="numeric"
              placeholder="No limit"
              defaultValue={link.maxDownloads ?? ''}
              className="w-40"
            />
            <p className="text-xs text-muted-foreground">
              Downloaded {link.downloadCount} time{link.downloadCount === 1 ? '' : 's'} so far.
            </p>
          </div>

          {state.error && (
            <p
              role="alert"
              className="animate-in text-sm text-destructive fade-in-0 slide-in-from-top-1 motion-spring"
            >
              {state.error}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={pending} pending={pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
