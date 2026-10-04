import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** How close to the end (in items) the list asks for the next page. */
const END_THRESHOLD = 40

interface VirtualListProps<T> extends Omit<ComponentProps<'div'>, 'children'> {
  items: readonly T[]
  getKey: (item: T) => string
  /** Fixed height of one row, in pixels. */
  itemHeight: number
  /** Columns, for a grid. Items flow left to right, then down. */
  lanes?: number
  renderItem: (item: T, index: number) => ReactNode
  /** Called when the user scrolls near the end, to load the next page. */
  onEndReached?: () => void
  /** Keeps this item in view, e.g. while moving through the list with the keyboard. */
  scrollToIndex?: number
  /**
   * Rows glide to their new place when items are added, removed or
   * re-sorted, with a spring. Only positions animate, never scrolling.
   */
  animateMoves?: boolean
  footer?: ReactNode
}

/**
 * A scroll container that only renders the rows in view, so a folder with
 * 100k entries stays fast (§10). The virtualizer lives in this one small
 * component because the React Compiler skips components that use it; the rows
 * it renders are separate, compiled components.
 *
 * Rows are placed with a transform alone, so moving one is a compositor-only
 * transition: a row's offset changes only when the items before it change,
 * never on scroll.
 */
export function VirtualList<T>({
  items,
  getKey,
  itemHeight,
  lanes = 1,
  renderItem,
  onEndReached,
  scrollToIndex = -1,
  animateMoves = false,
  footer,
  className,
  ...props
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- isolated in this component on purpose (see above)
  const virtualizer = useVirtualizer({
    count: items.length,
    lanes,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => itemHeight,
    getItemKey: (index) => {
      const item = items[index]
      return item === undefined ? index : getKey(item)
    },
    overscan: 10,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const lastRenderedIndex = virtualItems.at(-1)?.index ?? -1

  useEffect(() => {
    if (items.length > 0 && lastRenderedIndex >= items.length - END_THRESHOLD) onEndReached?.()
  }, [lastRenderedIndex, items.length, onEndReached])

  useEffect(() => {
    if (scrollToIndex >= 0) virtualizer.scrollToIndex(scrollToIndex, { align: 'auto' })
  }, [scrollToIndex, virtualizer])

  return (
    <div ref={scrollRef} className={cn('overflow-y-auto contain-content', className)} {...props}>
      {/*
        Keyed by the column count: when the grid reflows (a resize), the
        tiles are placed afresh instead of all flying to their new spots.
      */}
      <div key={lanes} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index]
          if (item === undefined) return null
          return (
            <div
              key={virtualItem.key}
              className={cn(
                'absolute top-0 left-0',
                animateMoves && 'transition-transform motion-spring',
              )}
              style={{
                width: `${100 / lanes}%`,
                height: itemHeight,
                // A percentage translate is relative to the row's own width: one column.
                transform: `translate(${virtualItem.lane * 100}%, ${virtualItem.start}px)`,
              }}
            >
              {renderItem(item, virtualItem.index)}
            </div>
          )
        })}
      </div>
      {footer}
    </div>
  )
}
