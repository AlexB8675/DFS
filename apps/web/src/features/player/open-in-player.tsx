import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Link2, RotateCcw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { sharesQuery } from '@/features/shares/api'
import { LinkBox } from '@/features/shares/link-box'
import { errorMessage } from '@/lib/api/client'
import type { FilePlace } from '@/lib/file-place'
import { makeStreamLink, playerKeys, streamLinkQuery } from './api'
import { currentDevice, EXTERNAL_PLAYERS, VLC } from './external-players'

// Playing a file in another player (DESIGN.md §6.7, §10.4): a share link's
// address for it (in the drive, the file's plain share link, made when asked
// to), opened at a tap in each player this device lets a page open (its own
// first, then VLC), and to paste where none can be (a computer). It plays
// what this browser can't: any sound, picture subtitles, every track.

interface OpenInPlayerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  place: FilePlace
  name: string
  kind: 'video' | 'audio'
}

export function OpenInPlayerDialog({ open, onOpenChange, place, name, kind }: OpenInPlayerProps) {
  const link = useQuery({ ...streamLinkQuery(place), enabled: open })
  const queryClient = useQueryClient()
  const make = useMutation({
    mutationFn: () => makeStreamLink(place),
    onSuccess: (made) => {
      queryClient.setQueryData(playerKeys.streamLink(place.path), made)
      void queryClient.invalidateQueries({ queryKey: sharesQuery.queryKey })
    },
  })
  const inDrive = place.token === null
  const device = currentDevice()
  const stream = link.data && { url: link.data.url, title: name, kind }
  // Those a tap opens here, in order: on a computer, none.
  const openable = stream
    ? EXTERNAL_PLAYERS.flatMap((player) => {
        const url = player.openUrl(stream, device)
        return url ? [{ player, url }] : []
      })
    : []
  const vlcHere = openable.some(({ player }) => player === VLC)
  const vlcHint = VLC.pasteHint(device)
  const vlcPage = VLC.getUrl(device)

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
          <DialogTitle>Open in another player</DialogTitle>
          <DialogDescription>
            A player on this device may play what this browser can’t. VLC plays this {kind} with
            every sound, subtitle and track it holds.
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
        ) : link.data === null ? (
          <div className="grid gap-3">
            <p className="text-muted-foreground">
              Another player plays it through a share link to this file. Anyone who has the link can
              play the file, until you turn it off in Shared links.
            </p>
            {make.error && <p className="text-destructive">{errorMessage(make.error)}</p>}
            <Button
              disabled={make.isPending}
              onClick={() => {
                make.mutate()
              }}
            >
              {make.isPending ? <Spinner /> : <Link2 />} Make a share link
            </Button>
          </div>
        ) : (
          <div className="grid gap-3">
            {openable.length > 0 ? (
              <div className="grid gap-2">
                {openable.map(({ player, url }, index) => (
                  <Button key={player.id} variant={index === 0 ? 'default' : 'outline'} asChild>
                    <a href={url}>
                      <ExternalLink /> Open in {player.name(device)}
                    </a>
                  </Button>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">
                A page can’t open a player on a computer: copy the link, and open it in the player.
              </p>
            )}
            <LinkBox url={link.data.url} label="Stream link" />
            {vlcHint && <p className="text-muted-foreground">{vlcHint}</p>}
            <p className="flex gap-2 text-muted-foreground [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
              <TriangleAlert />
              <span>
                {inDrive
                  ? 'It plays through this file’s share link: anyone who has it can play the file, until you turn the link off in Shared links.'
                  : 'Anyone who has it can play this file, while this share link works.'}
              </span>
            </p>
            {vlcPage && (
              <p className="text-muted-foreground">
                {vlcHere ? 'No VLC here?' : 'No VLC on this computer?'}{' '}
                <a
                  href={vlcPage}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  Get VLC
                </a>
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
