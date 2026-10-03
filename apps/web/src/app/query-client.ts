import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { isUnauthorized } from '@/lib/api/client'

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: {
      /** Set on the session check itself, whose 401 the router handles. */
      skipAuthRedirect?: boolean
    }
  }
}

/** Sends the user to the login page when their session ends mid-use. */
function redirectToLogin(error: unknown): void {
  if (!isUnauthorized(error) || window.location.pathname === '/login') return
  const next = window.location.pathname + window.location.search
  window.location.assign(`/login?error=session_expired&next=${encodeURIComponent(next)}`)
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (!query.meta?.skipAuthRedirect) redirectToLogin(error)
    },
  }),
  mutationCache: new MutationCache({ onError: redirectToLogin }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) => !isUnauthorized(error) && failureCount < 2,
    },
  },
})
