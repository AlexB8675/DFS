import { useQuery } from '@tanstack/react-query'
import { Download, ExternalLink, RotateCcw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { LinkBox } from '@/features/shares/link-box'
import { errorMessage } from '@/lib/api/client'
import type { FilePlace } from '@/lib/file-place'
import { formatFullDate } from '@/lib/format'
import { streamLinkQuery } from './api'
import { currentDevice, playlistFile, VLC, type ExternalPlayer } from './external-players'

// Playing a file in another player (DESIGN.md §6.7, §10.4): a stream link
// for it, opened in VLC where a page can open VLC (a phone), else as a
// playlist file a computer opens in it, or pasted. It plays what this
// browser can't: any sound, picture subtitles, every track.

interface OpenInPlayerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  place: FilePlace
  name: string
  kind: 'video' | 'audio'
  player?: ExternalPlayer
}

export function OpenInPlayerDialog({
  open,
  onOpenChange,
  place,
  name,
  kind,
  player = VLC,
}: OpenInPlayerProps) {
  const link = useQuery({ ...streamLinkQuery(place), enabled: open })
  const device = currentDevice()
  const stream = link.data && { url: link.data.url, title: name, kind }
  const openUrl = stream ? player.openUrl(stream, device) : null

  function downloadPlaylist() {
    if (!stream) return
    const address = URL.createObjectURL(playlistFile(stream))
    const anchor = document.createElement('a')
    anchor.href = address
    anchor.download = `${name.replace(/\.[^.]+$/, '') || name}.m3u`
    anchor.click()
    URL.revokeObjectURL(address)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        // Over the viewer: its keys (← →, Space) are the dialog's while it is open.
        onKeyDown={(event) => {
          event.stopPropagation()
        }}
      >
        <DialogHeader>
          <DialogTitle>Open in {player.name}</DialogTitle>
          <DialogDescription>
            {player.name} plays this {kind} with every sound, subtitle and track it holds, whatever
            this browser can play.
          </DialogDescription>
        </DialogHeader>
        {link.isPending ? (
          <div className="flex justify-center py-4">
            <Spinner className="size-6" />
          </div>
        ) : link.isError ? (
          <div className="grid gap-3">
            <p className="text-destructive">{errorMessage(link.error)}</p>
            <Button
              variant="outline"
              className="justify-self-start"
              onClick={() => void link.refetch()}
            >
              <RotateCcw /> Try again
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            {openUrl ? (
              <Button asChild>
                <a href={openUrl}>
                  <ExternalLink /> Open in {player.name}
                </a>
              </Button>
            ) : (
              <div className="grid gap-1.5">
                <Button onClick={downloadPlaylist}>
                  <Download /> Download playlist
                </Button>
                <p className="text-xs text-muted-foreground">
                  It opens in {player.name} where {player.name} plays your playlists (.m3u).
                </p>
              </div>
            )}
            <LinkBox url={link.data.url} label="Stream link" />
            <p className="text-muted-foreground">{player.pasteHint(device)}</p>
            <p className="flex gap-2 text-muted-foreground [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
              <TriangleAlert />
              <span>
                Anyone with this link can play this file until {formatFullDate(link.data.expiresAt)}
                .
              </span>
            </p>
            <p className="text-muted-foreground">
              No {player.name} here?{' '}
              <a
                href={player.getUrl(device)}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-4"
              >
                Get {player.name}
              </a>
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
