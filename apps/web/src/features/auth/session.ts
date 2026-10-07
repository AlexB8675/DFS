import {
  sessionSchema,
  type ChangePasswordInput,
  type LoginInput,
  type PasswordResetRequest,
  type Session,
  type User,
} from '@dfs/shared'
import { queryOptions, useSuspenseQuery } from '@tanstack/react-query'
import { redirect, type LoaderFunctionArgs } from 'react-router'
import { queryClient } from '@/app/query-client'
import { apiGet, apiSend, isUnauthorized, setCsrfToken } from '@/lib/api/client'

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

/**
 * Route loader: sends visitors without a session to the login page, and a
 * session opened with a temporary password to choose a new one first (§7.1).
 */
export async function requireSession({ request }: LoaderFunctionArgs): Promise<null> {
  const { pathname, search } = new URL(request.url)
  const next = pathname + search
  const query = next === '/' ? '' : `?next=${encodeURIComponent(next)}`
  let session: Session
  try {
    // A cached session is used as-is; it is only fetched on the first load.
    session = await queryClient.query({ ...sessionQuery, staleTime: 'static' })
  } catch (error) {
    if (!isUnauthorized(error)) throw error
    throw redirect(`/login${query}`)
  }
  if (session.passwordChange) throw redirect(`/choose-password${query}`)
  return null
}

/** Route loader for the login page: skips it when already signed in. */
export async function redirectIfSignedIn({ request }: LoaderFunctionArgs): Promise<null> {
  let session: Session
  try {
    session = await queryClient.query(sessionQuery)
  } catch {
    return null
  }
  const { search } = new URL(request.url)
  throw redirect(session.passwordChange ? `/choose-password${search}` : afterSignIn(search))
}

/** Route loader for `/choose-password`: only for a session that must choose one. */
export async function requirePasswordChange({ request }: LoaderFunctionArgs): Promise<null> {
  const { search } = new URL(request.url)
  let session: Session
  try {
    session = await queryClient.query({ ...sessionQuery, staleTime: 'static' })
  } catch (error) {
    if (!isUnauthorized(error)) throw error
    throw redirect(`/login${search}`)
  }
  if (!session.passwordChange) throw redirect(afterSignIn(search))
  return null
}

/** Where to go once signed in, from a `?next=` in `search`. */
function afterSignIn(search: string): string {
  return safeNextPath(new URLSearchParams(search).get('next'))
}

/**
 * Signs in (§7.1). A temporary password gives a session that can only
 * choose a new password: check `passwordChange` on the result.
 */
export async function signIn(credentials: LoginInput): Promise<Session> {
  const session = await apiSend('POST', '/auth/login', credentials, sessionSchema)
  acceptSession(session)
  return session
}

/**
 * Asks the admins for a new password, by username (§7.1). The answer is the
 * same whether or not the account exists.
 */
export async function requestPasswordReset(input: PasswordResetRequest): Promise<void> {
  await apiSend('POST', '/auth/password-reset', input)
}

/** Changes the password. The API renews this session and ends every other one. */
export async function changePassword(input: ChangePasswordInput): Promise<Session> {
  const session = await apiSend('POST', '/auth/password', input, sessionSchema)
  acceptSession(session)
  return session
}

function acceptSession(session: Session): void {
  setCsrfToken(session.csrfToken)
  queryClient.setQueryData(sessionQuery.queryKey, session)
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
