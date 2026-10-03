import { Skeleton } from '@/components/ui/skeleton'

/** Placeholder rows while a list loads. */
export function ListSkeleton() {
  return (
    <div className="flex-1 space-y-1 p-3" aria-busy aria-label="Loading">
      {Array.from({ length: 10 }, (_, index) => (
        <div key={index} className="flex h-10 items-center gap-3 px-3">
          <Skeleton className="size-5 rounded" />
          <Skeleton className="h-4" style={{ width: `${30 + ((index * 17) % 40)}%` }} />
        </div>
      ))}
    </div>
  )
}
