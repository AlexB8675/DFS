import { GripVertical, Volume2, X } from 'lucide-react'
import { useRef, useState, type PointerEvent } from 'react'
import { Button } from '@/components/ui/button'
import { formatPlayTime } from '@/features/player/time'
import { cn } from '@/lib/utils'
import { moveEntry, playEntry, removeEntry, trackTitle } from './engine'
import { useAudioStore } from './store'

/**
 * The queue (§10.4), in the order the listener arranged it: a track plays
 * when chosen, moves by dragging its handle (or with ↑ and ↓ on it), and
 * goes with ×.
 */
export function QueueList({ className }: { className?: string }) {
  const tracks = useAudioStore((state) => state.queue.tracks)
  const playing = useAudioStore((state) => state.queue.order[state.queue.at])
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const list = useRef<HTMLOListElement>(null)

  /** The row a dragged track would land on, by the pointer's height. */
  function rowAt(event: PointerEvent): number {
    const rows = Array.from(list.current?.children ?? [])
    const below = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect()
      return event.clientY < rect.top + rect.height / 2
    })
    return below === -1 ? rows.length - 1 : below
  }

  return (
    <ol ref={list} className={cn('grid gap-0.5', className)}>
      {tracks.map((track, i) => {
        const current = track.key === playing
        const landing = drag !== null && drag.to === i && drag.from !== i
        return (
          <li
            key={track.key}
            className={cn(
              'group flex items-center gap-1 rounded-md border-y-2 border-transparent py-0.5 pr-1',
              current && 'bg-accent text-accent-foreground',
              drag?.from === i && 'opacity-50',
              landing && (drag.to > drag.from ? 'border-b-primary' : 'border-t-primary'),
            )}
          >
            <button
              type="button"
              aria-label={`Move ${trackTitle(track)}`}
              className="flex h-9 w-7 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground active:cursor-grabbing"
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.currentTarget.setPointerCapture(event.pointerId)
                setDrag({ from: i, to: i })
              }}
              onPointerMove={(event) => {
                if (drag) setDrag({ ...drag, to: rowAt(event) })
              }}
              onPointerUp={() => {
                if (drag && drag.to !== drag.from) moveEntry(drag.from, drag.to)
                setDrag(null)
              }}
              onPointerCancel={() => {
                setDrag(null)
              }}
              onKeyDown={(event) => {
                const by = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
                if (by === 0 || i + by < 0 || i + by >= tracks.length) return
                event.preventDefault()
                moveEntry(i, i + by)
              }}
            >
              <GripVertical className="size-4" />
            </button>
            <button
              type="button"
              className="min-w-0 flex-1 py-1 text-left"
              aria-current={current ? 'true' : undefined}
              onClick={() => {
                playEntry(track.key)
              }}
            >
              <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                {current && <Volume2 className="size-3.5 shrink-0 text-primary" aria-hidden />}
                <span className="truncate">{trackTitle(track)}</span>
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {track.artist ?? track.name}
              </span>
            </button>
            {track.durationMs !== null && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatPlayTime(track.durationMs / 1000)}
              </span>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${trackTitle(track)} from the queue`}
              className="shrink-0"
              onClick={() => {
                removeEntry(track.key)
              }}
            >
              <X />
            </Button>
          </li>
        )
      })}
    </ol>
  )
}
