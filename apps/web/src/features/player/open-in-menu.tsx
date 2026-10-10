import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, ExternalLink } from 'lucide-react'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { copyLink, sharesQuery } from '@/features/shares/api'
import { errorMessage } from '@/lib/api/client'
import type { FilePlace } from '@/lib/file-place'
import { makeStreamLink, playerKeys, streamLinkQuery } from './api'
import { currentDevice, playersFor, type ExternalPlayer, type Opening } from './external-players'

// Open in…: one menu of the players that play this file on this device, its
// own first, then VLC (DESIGN.md §6.7, §10.4), and its link to copy. Each
// plays a share link's address for it, which in the drive is the file's plain
// share link, made when first chosen. A phone's player opens at once; a
// computer's from a playlist of the link, downloaded and opened.

interface OpenInMenuProps {
  place: FilePlace
  name: string
  kind: 'video' | 'audio'
  /** The button that opens it. */
  children: ReactNode
  /** Called as a player is chosen: the browser's player pauses, as it goes on there. */
  onChosen?: () => void
  /** Where the menu opens: the player itself in full screen. */
  container?: ComponentProps<typeof DropdownMenuContent>['container']
  align?: 'start' | 'center' | 'end'
}

export function OpenInMenu({
  place,
  name,
  kind,
  children,
  onChosen,
  container,
  align = 'end',
}: OpenInMenuProps) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  // Asked as the menu opens, so a choice has its address at once: a phone opens an app only while the tap is fresh.
  const link = useQuery({ ...streamLinkQuery(place), enabled: open })
  const device = currentDevice()
  const players = playersFor(device)
  const inDrive = place.token === null

  /** The address, made where the drive file has no plain share link yet. */
  async function address(): Promise<string> {
    const query = streamLinkQuery(place)
    // The one the menu asked for as it opened, if it is back; else asked now.
    const cached = queryClient.getQueryData(query.queryKey)
    const known =
      cached !== undefined ? cached : await queryClient.query({ ...query, staleTime: 'static' })
    if (known) return known.url
    const made = await makeStreamLink(place)
    queryClient.setQueryData(playerKeys.streamLink(place.path), made)
    void queryClient.invalidateQueries({ queryKey: sharesQuery.queryKey })
    toast.success('Made a share link to this file', {
      description: 'Another player plays it through the link. Turn it off in Shared links.',
    })
    return made.url
  }

  async function play(player: ExternalPlayer) {
    onChosen?.()
    try {
      openIn(
        player.opening({ url: await address(), title: name, kind }, device),
        player.name(device),
      )
    } catch (error) {
      toast.error(`Couldn’t open it in ${player.name(device)}`, {
        description: errorMessage(error),
      })
    }
  }

  async function copy() {
    try {
      await copyLink(await address())
    } catch (error) {
      toast.error('Couldn’t copy the link', { description: errorMessage(error) })
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent container={container} align={align} className="w-64">
        <DropdownMenuLabel>Open in</DropdownMenuLabel>
        {players.map((player) => (
          <DropdownMenuItem
            key={player.id}
            onSelect={() => {
              void play(player)
            }}
          >
            <ExternalLink /> {player.name(device)}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void copy()
          }}
        >
          <Copy /> Copy link
        </DropdownMenuItem>
        <p className="px-1.5 pt-1 pb-0.5 text-xs text-muted-foreground">
          {inDrive && link.data === null
            ? 'This makes a share link to the file: anyone who has it can play the file, until you turn it off in Shared links.'
            : 'Through a share link: anyone who has it can play this file while the link works.'}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Goes to a player's address, or downloads its playlist to open. */
function openIn(opening: Opening, playerName: string): void {
  if (opening.kind === 'address') {
    window.location.href = opening.url
    return
  }
  const address = URL.createObjectURL(opening.file)
  const anchor = document.createElement('a')
  anchor.href = address
  anchor.download = opening.fileName
  anchor.click()
  window.setTimeout(() => {
    URL.revokeObjectURL(address)
  }, 10_000)
  toast(`Open “${opening.fileName}” from your downloads`, {
    description: `It plays in ${playerName.replace(/^This /, 'this ')}. To skip this step next time, choose “Always open files of this type” for it.`,
  })
}
