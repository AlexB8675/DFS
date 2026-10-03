import { sessionSchema, type Session, type User } from '@dfs/shared'
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query'
import { redirect, type LoaderFunctionArgs, type NavigateFunction } from 'react-router'
import { queryClient } from '@/app/query-client'
import { apiGet, apiSend, isUnauthorized, setCsrfToken } from '@/lib/api/client'
import { mocksEnabled } from '@/lib/env'

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async ({ signal }) => {
    const session = await apiGet('/auth/me', sessionSchema, { signal })
    setCsrfToken(session.csrfToken)
    return session
  },
  staleTime: 5 * 60_000,
  meta: { skipAuthRedirect: true },
})

/** The signed-in session. Only for routes below `requireSession`, which loads it first. */
export function useSession(): Session {
  return useSuspenseQuery(sessionQuery).data
}

export function useCurrentUser(): User {
  return useSession().user
}

/** Route loader: sends visitors without a session to the login page. */
export async function requireSession({ request }: LoaderFunctionArgs): Promise<null> {
  try {
    // A cached session is used as-is; it is only fetched on the first load.
    await queryClient.query({ ...sessionQuery, staleTime: 'static' })
    return null
  } catch (error) {
    if (!isUnauthorized(error)) throw error
    const { pathname, search } = new URL(request.url)
    const next = pathname + search
    throw redirect(next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`)
  }
}

/** Route loader for the login page: skips it when already signed in. */
export async function redirectIfSignedIn({ request }: LoaderFunctionArgs): Promise<null> {
  try {
    await queryClient.query(sessionQuery)
  } catch {
    return null
  }
  throw redirect(safeNextPath(new URL(request.url).searchParams.get('next')))
}

/**
 * Starts "Log in with Discord" (§7.1). The real flow is a full-page redirect
 * through Discord's OAuth screen, which a mocked API cannot intercept, so mock
 * mode signs in with a local request instead.
 */
export async function signIn(next: string, navigate: NavigateFunction): Promise<void> {
  if (!mocksEnabled) {
    window.location.assign(`/api/auth/discord?next=${encodeURIComponent(next)}`)
    return
  }
  await apiSend('POST', '/auth/dev-login')
  queryClient.removeQueries({ queryKey: sessionQuery.queryKey })
  await navigate(next, { replace: true })
}

export async function signOut(): Promise<void> {
  try {
    await apiSend('POST', '/auth/logout')
  } finally {
    setCsrfToken(null)
    queryClient.clear()
    // A full load drops every bit of in-memory state from the old session.
    window.location.assign('/login')
  }
}

/**
 * Only same-origin paths, so `?next=` cannot be used as an open redirect.
 * Browsers read `\` as `/`, so `/\evil.com` would mean `//evil.com`.
 * The API must apply the same check to the `next` it receives.
 */
export function safeNextPath(next: string | null): string {
  if (!next?.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/drive'
  return next
}
