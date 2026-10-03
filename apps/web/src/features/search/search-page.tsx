import { searchPageSchema } from '@dfs/shared'
import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query'
import { SearchX } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ListSkeleton } from '@/components/list-skeleton'
import { DriveToolbar } from '@/features/drive/drive-toolbar'
import { NodeList } from '@/features/drive/node-list'
import { SelectionProvider } from '@/features/drive/selection-provider'
import { StatusBar } from '@/features/drive/status-bar'
import { apiGet } from '@/lib/api/client'

function searchQuery(q: string) {
  return infiniteQueryOptions({
    queryKey: ['search', q],
    queryFn: ({ pageParam, signal }) =>
      apiGet('/search', searchPageSchema, { query: { q, cursor: pageParam, limit: 100 }, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: q.length > 0,
  })
}

/** `/search?q=`: name search across the whole drive (§9). */
export function SearchPage() {
  const [searchParams] = useSearchParams()
  const q = searchParams.get('q')?.trim() ?? ''
  const results = useInfiniteQuery(searchQuery(q))
  const nodes = results.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <SelectionProvider key={q}>
      <title>{q ? `“${q}” – Search – DFS` : 'Search – DFS'}</title>
      <DriveToolbar
        nodes={nodes}
        sortable={false}
        title={
          <h1 className="truncate px-1 text-base font-semibold">
            {q ? `Results for “${q}”` : 'Search'}
          </h1>
        }
      />
      {q && results.isPending ? (
        <ListSkeleton />
      ) : (
        <NodeList
          nodes={nodes}
          folderId={null}
          label="Search results"
          showLocation
          sortable={false}
          hasMore={results.hasNextPage}
          isLoadingMore={results.isFetchingNextPage}
          onLoadMore={() => void results.fetchNextPage()}
          empty={
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchX />
                </EmptyMedia>
                <EmptyTitle>{q ? 'No matches' : 'Search your drive'}</EmptyTitle>
                <EmptyDescription>
                  {q
                    ? 'No file or folder name contains that text. Items in the trash are not searched.'
                    : 'Type part of a file or folder name into the search box.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          }
        />
      )}
      <StatusBar nodes={nodes} hasMore={results.hasNextPage} />
    </SelectionProvider>
  )
}
