import { createChannelSchema, type StorageChannel } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { Hash, Plus } from 'lucide-react'
import { useActionState, useState } from 'react'
import { toast } from 'sonner'
import { ListSkeleton } from '@/components/list-skeleton'
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
import { Switch } from '@/components/ui/switch'
import { errorMessage } from '@/lib/api/client'
import { formatBytes, formatDate, formatFullDate } from '@/lib/format'
import { formText } from '@/lib/form-data'
import { cn } from '@/lib/utils'
import { channelsQuery, useCreateChannel, useSetChannelEnabled } from './api'

/** `/admin/channels`: the Discord channels blobs are stored in (§4). */
export function ChannelsPage() {
  const channels = useQuery(channelsQuery)
  const [adding, setAdding] = useState(false)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-5 py-3">
        <p className="flex-1 text-sm text-muted-foreground">
          New blobs go to the least busy enabled channel. Disabled channels stay readable.
        </p>
        <Button
          onClick={() => {
            setAdding(true)
          }}
        >
          <Plus /> Add channel
        </Button>
      </div>
      {channels.data ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full table-fixed text-sm">
            <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
              <tr className="border-y text-left">
                <th className="py-2 pl-5 font-medium">Channel</th>
                <th className="hidden w-48 py-2 pl-4 font-medium md:table-cell">Discord ID</th>
                <th className="hidden w-24 py-2 pl-4 text-right font-medium sm:table-cell">
                  Blobs
                </th>
                <th className="hidden w-28 py-2 pl-4 text-right font-medium sm:table-cell">
                  Stored
                </th>
                <th className="w-36 py-2 pr-5 text-right font-medium">Takes new blobs</th>
              </tr>
            </thead>
            <tbody>
              {channels.data.map((channel) => (
                <ChannelRow key={channel.id} channel={channel} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ListSkeleton />
      )}
      {adding && (
        <AddChannelDialog
          onClose={() => {
            setAdding(false)
          }}
        />
      )}
    </div>
  )
}

function ChannelRow({ channel }: { channel: StorageChannel }) {
  const setEnabled = useSetChannelEnabled()

  return (
    <tr className="border-b border-border/50 hover:bg-muted/40">
      <td className="py-2.5 pl-5">
        <span
          className={cn('flex items-center gap-2', !channel.enabled && 'text-muted-foreground')}
        >
          <Hash className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-medium">{channel.name}</span>
        </span>
        <span
          className="ml-6 block text-xs text-muted-foreground"
          title={formatFullDate(channel.createdAt)}
        >
          Added {formatDate(channel.createdAt)}
        </span>
      </td>
      <td className="hidden truncate py-2.5 pl-4 font-mono text-xs text-muted-foreground md:table-cell">
        {channel.discordChannelId}
      </td>
      <td className="hidden py-2.5 pl-4 text-right tabular-nums sm:table-cell">
        {channel.blobCount.toLocaleString()}
      </td>
      <td className="hidden py-2.5 pl-4 text-right text-muted-foreground tabular-nums sm:table-cell">
        {formatBytes(channel.storedBytes)}
      </td>
      <td className="py-2.5 pr-5 text-right">
        <Switch
          checked={channel.enabled}
          aria-label={`#${channel.name} takes new blobs`}
          onCheckedChange={(enabled) => {
            setEnabled.mutate(
              { id: channel.id, enabled },
              {
                onError: (error) => {
                  toast.error(`Could not change #${channel.name}`, {
                    description: errorMessage(error),
                  })
                },
              },
            )
          }}
        />
      </td>
    </tr>
  )
}

interface FormState {
  name: string
  discordChannelId: string
  error: string | null
}

function AddChannelDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateChannel()
  const [state, submit, pending] = useActionState(
    async (_previous: FormState, formData: FormData): Promise<FormState> => {
      const input = {
        name: formText(formData, 'name'),
        discordChannelId: formText(formData, 'discordChannelId').trim(),
      }
      const parsed = createChannelSchema.safeParse(input)
      if (!parsed.success) {
        return { ...input, error: parsed.error.issues[0]?.message ?? 'Check the fields.' }
      }
      try {
        const channel = await create.mutateAsync(parsed.data)
        toast.success(`Added #${channel.name}`)
        onClose()
        return { ...input, error: null }
      } catch (error) {
        return { ...input, error: errorMessage(error) }
      }
    },
    { name: '', discordChannelId: '', error: null },
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form action={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add a storage channel</DialogTitle>
            <DialogDescription>
              Create a text channel on the DFS server that only the bot can see, then paste its ID
              (Developer Mode → right-click → Copy Channel ID).
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" defaultValue={state.name} placeholder="storage-04" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="discordChannelId">Discord channel ID</Label>
            <Input
              id="discordChannelId"
              name="discordChannelId"
              inputMode="numeric"
              defaultValue={state.discordChannelId}
              placeholder="112233445566778899"
              className="font-mono"
            />
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
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />} Add channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
