import { loginSchema } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { CircleAlert, FlaskConical, LogIn } from 'lucide-react'
import { useRef, useState, type SubmitEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { z } from 'zod'
import { AppLogo } from '@/components/app-logo'
import { PasswordInput } from '@/components/password-input'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { ApiError, apiGet, errorMessage } from '@/lib/api/client'
import { mocksEnabled } from '@/lib/env'
import { formatDuration } from '@/lib/format'
import { shake } from '@/lib/motion'
import { prepareNavTransition } from '@/lib/navigation'
import { AuthScreen } from './auth-screen'
import { safeNextPath, signIn } from './session'

interface Notice {
  title: string
  detail: string
}

/** Why the user landed here, from `?error=`. */
const REASONS: Record<string, Notice> = {
  session_expired: {
    title: 'Your session has ended',
    detail: 'Sign in again to pick up where you left off.',
  },
}

/** What a failed sign-in means, by error code (§7.1). */
function describeFailure(error: unknown): Notice {
  if (!(error instanceof ApiError)) {
    return { title: 'Couldn’t sign in', detail: errorMessage(error) }
  }
  switch (error.code) {
    case 'invalid_credentials':
      return {
        title: 'Wrong username or password',
        detail: 'Check both and try again. Capital letters don’t matter in the username.',
      }
    case 'account_disabled':
      return { title: 'This account is disabled', detail: error.message }
    case 'password_expired':
      return { title: 'Your temporary password has expired', detail: error.message }
    default:
      if (error.status === 429) {
        const wait = error.retryAfterMs === null ? null : formatDuration(error.retryAfterMs / 1000)
        return {
          title: 'Too many tries',
          detail: wait ? `Wait ${wait} before trying again.` : 'Wait a little before trying again.',
        }
      }
      return { title: 'Couldn’t sign in', detail: error.message }
  }
}

export function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Notice | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const next = searchParams.get('next')
  const notice = failure ?? REASONS[searchParams.get('error') ?? '']

  function fail(reason: Notice) {
    setFailure(reason)
    shake(cardRef.current)
    const field = username ? passwordRef.current : usernameRef.current
    field?.focus()
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const credentials = loginSchema.safeParse({ username, password })
    if (!credentials.success) {
      fail({ title: 'Enter your username and password', detail: 'Both are needed to sign in.' })
      return
    }
    setPending(true)
    try {
      const session = await signIn(credentials.data)
      const query = next ? `?next=${encodeURIComponent(next)}` : ''
      // The drive (or the password page) zooms in as this page fades out.
      await navigate(session.passwordChange ? `/choose-password${query}` : safeNextPath(next), {
        replace: true,
        viewTransition: prepareNavTransition('section'),
      })
    } catch (error) {
      setPassword('')
      setPending(false)
      fail(describeFailure(error))
    }
  }

  return (
    <AuthScreen>
      <title>Sign in – DFS</title>

      <Card
        ref={cardRef}
        className="relative w-full max-w-sm animate-in duration-300 ease-smooth fade-in-0 slide-in-from-bottom-2"
      >
        <CardHeader className="items-center text-center">
          <AppLogo className="mx-auto mb-2 [&_svg]:size-12" />
          <CardTitle className="text-xl">Sign in to DFS</CardTitle>
          <CardDescription>Your private cloud drive, stored on Discord.</CardDescription>
        </CardHeader>

        <CardContent>
          <form className="grid gap-4" noValidate onSubmit={(event) => void handleSubmit(event)}>
            {notice && (
              <div
                role="alert"
                className="flex animate-in gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm fade-in-0 zoom-in-95 motion-spring"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                <div className="grid gap-0.5">
                  <p className="font-medium">{notice.title}</p>
                  <p className="text-muted-foreground">{notice.detail}</p>
                </div>
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                ref={usernameRef}
                id="username"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                value={username}
                aria-invalid={failure !== null && !username}
                onChange={(event) => {
                  setUsername(event.target.value)
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <PasswordInput
                ref={passwordRef}
                id="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                }}
              />
            </div>

            <Button type="submit" size="lg" className="mt-1 h-10" disabled={pending}>
              {pending ? <Spinner /> : <LogIn />}
              Sign in
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              An admin makes your account. If you forgot your password, ask them to reset it.
            </p>
          </form>
        </CardContent>

        {mocksEnabled && (
          <DemoAccounts
            onPick={(account) => {
              setUsername(account.username)
              setPassword(account.password)
              setFailure(null)
            }}
          />
        )}
      </Card>
    </AuthScreen>
  )
}

// ── Demo mode ────────────────────────────────────────────────────────────────

const demoAccountsSchema = z.array(
  z.object({ username: z.string(), password: z.string(), label: z.string() }),
)
type DemoAccount = z.infer<typeof demoAccountsSchema>[number]

/** Mock mode only: the seeded sign-ins, one click to fill the form. */
function DemoAccounts({ onPick }: { onPick: (account: DemoAccount) => void }) {
  const accounts = useQuery({
    queryKey: ['dev', 'accounts'],
    queryFn: ({ signal }) => apiGet('/dev/accounts', demoAccountsSchema, { signal }),
    staleTime: Infinity,
  })

  return (
    <CardFooter className="grid gap-2 border-t text-xs text-muted-foreground">
      <p className="flex items-center justify-center gap-2">
        <FlaskConical className="size-3.5" aria-hidden />
        Demo mode: data stays in this browser. Try an account:
      </p>
      <ul className="grid gap-1">
        {accounts.data?.map((account, index) => (
          <li
            key={account.username}
            className="animate-in fade-in-0 slide-in-from-bottom-1 motion-spring"
            style={{ animationDelay: `${index * 30}ms` }}
          >
            <button
              type="button"
              className="pressable flex w-full items-center justify-between gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => {
                onPick(account)
              }}
            >
              <span className="font-mono text-foreground">{account.username}</span>
              <span className="truncate">{account.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </CardFooter>
  )
}
