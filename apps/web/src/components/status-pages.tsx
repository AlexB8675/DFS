import { FileQuestion, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isRouteErrorResponse, Link, useRouteError } from 'react-router'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Spinner } from '@/components/ui/spinner'
import { transitionLinkProps } from '@/lib/navigation'
import { isMissingModule, reloadIfOutdated } from '@/lib/version-check'

/** Shown while the first route loads (session check). */
export function SplashScreen() {
  return (
    <div className="flex min-h-dvh animate-in flex-col items-center justify-center gap-6 bg-background duration-300 ease-smooth fade-in-0">
      <AppLogo className="[&_svg]:size-12" />
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  )
}

export function NotFoundPage() {
  return (
    <Empty className="flex-1">
      <title>Not found – DFS</title>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileQuestion />
        </EmptyMedia>
        <EmptyTitle>Page not found</EmptyTitle>
        <EmptyDescription>The page you’re looking for doesn’t exist.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild variant="outline">
          <Link to="/drive" {...transitionLinkProps('section')}>
            Go to My Drive
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  )
}

/** The router's error boundary: an unexpected error while rendering or loading a route. */
export function RouteError() {
  const error = useRouteError()
  // A page from before a deploy asks for a part of itself the deploy
  // removed: it reloads into the new version instead, at the same address.
  const [updating, setUpdating] = useState(() => isMissingModule(error))
  useEffect(() => {
    if (!updating) return
    void reloadIfOutdated().then((reloading) => {
      if (!reloading) setUpdating(false)
    })
  }, [updating])
  if (updating) return <SplashScreen />

  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unknown error'

  return (
    <Empty className="min-h-dvh">
      <title>Error – DFS</title>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlert />
        </EmptyMedia>
        <EmptyTitle>Something went wrong</EmptyTitle>
        <EmptyDescription className="font-mono text-xs">{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button
          onClick={() => {
            window.location.reload()
          }}
        >
          Reload
        </Button>
        <Button asChild variant="outline">
          <a href="/drive">Go to My Drive</a>
        </Button>
      </EmptyContent>
    </Empty>
  )
}
