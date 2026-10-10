import { Search } from 'lucide-react'
import { useRef } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { useHotkey } from '@/lib/use-hotkey'
import { useMediaQuery } from '@/lib/use-media-query'
import { useTransitionNavigate } from '@/lib/navigation'
import { cn } from '@/lib/utils'

/** Searches file and folder names. Press `/` anywhere to focus it. */
export function SearchBox({ className }: { className?: string }) {
  const navigate = useTransitionNavigate()
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const inputRef = useRef<HTMLInputElement>(null)
  // "Search in Drive" needs more room than a phone's header has left; "Search" fits.
  const roomy = useMediaQuery('(min-width: 25rem)')
  const query = pathname === '/search' ? (searchParams.get('q') ?? '') : ''

  useHotkey('/', () => inputRef.current?.focus())

  return (
    <form
      role="search"
      className={cn('relative', className)}
      onSubmit={(event) => {
        event.preventDefault()
        const value = new FormData(event.currentTarget).get('q')
        const q = typeof value === 'string' ? value.trim() : ''
        if (q) navigate(`/search?q=${encodeURIComponent(q)}`, 'section')
        inputRef.current?.blur()
      }}
    >
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        // Re-mount when the URL query changes, so the field shows it.
        key={query}
        ref={inputRef}
        name="q"
        type="search"
        defaultValue={query}
        placeholder={roomy ? 'Search in Drive' : 'Search'}
        aria-label="Search files and folders"
        autoComplete="off"
        className="h-9 rounded-md bg-muted/60 pr-3 pl-9 focus-visible:bg-background sm:pr-10"
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
      />
      <Kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 sm:inline-flex">
        /
      </Kbd>
    </form>
  )
}
