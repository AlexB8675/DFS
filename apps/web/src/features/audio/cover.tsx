import { Music } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { coverUrl } from './engine'
import type { QueuedTrack } from './queue'

/** A track's cover (§6.7), or a note in its place when it has none, or it doesn't load. */
export function Cover({ track, className }: { track: QueuedTrack; className?: string }) {
  const url = coverUrl(track)
  const [failed, setFailed] = useState<string | null>(null)
  if (!url || failed === url) {
    return (
      <div
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground',
          className,
        )}
      >
        <Music className="size-1/2" />
      </div>
    )
  }
  return (
    <img
      src={url}
      alt=""
      draggable={false}
      className={cn('shrink-0 rounded-md bg-muted object-cover', className)}
      onError={() => {
        setFailed(url)
      }}
    />
  )
}
