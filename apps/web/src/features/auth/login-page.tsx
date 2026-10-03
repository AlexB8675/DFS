import { CircleAlert, FlaskConical, LogIn } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { errorMessage } from '@/lib/api/client'
import { mocksEnabled } from '@/lib/env'
import { safeNextPath, signIn } from './session'

/** Why the user landed here, as set by the OAuth callback or a lapsed session. */
const LOGIN_ERRORS: Record<string, { title: string; detail: string }> = {
  missing_role: {
    title: 'You don’t have access yet',
    detail:
      'Ask an admin to give you the “DFS User” role in the DFS Discord server, then try again.',
  },
  not_a_member: {
    title: 'You’re not in the DFS server',
    detail: 'Only members of the DFS Discord server can sign in. Ask an admin for an invite.',
  },
  oauth_failed: {
    title: 'Sign-in didn’t finish',
    detail: 'The Discord sign-in was cancelled or failed. Please try again.',
  },
  session_expired: {
    title: 'Your session has ended',
    detail: 'Sign in again to pick up where you left off.',
  },
}

export function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const next = safeNextPath(searchParams.get('next'))
  const reason = LOGIN_ERRORS[searchParams.get('error') ?? '']

  async function handleSignIn() {
    setPending(true)
    setFailure(null)
    try {
      await signIn(next, navigate)
    } catch (error) {
      setFailure(errorMessage(error))
      setPending(false)
    }
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-4">
      <title>Sign in – DFS</title>
      {/* A soft glow behind the card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 size-[42rem] -translate-x-1/2 -translate-y-1/2 animate-in rounded-full bg-primary/10 blur-3xl duration-1000 ease-smooth fade-in-0"
      />

      <Card className="relative w-full max-w-sm animate-in duration-300 ease-smooth fade-in-0 slide-in-from-bottom-2">
        <CardHeader className="items-center text-center">
          <AppLogo className="mx-auto mb-2 [&_svg]:size-12" />
          <CardTitle className="text-xl">Sign in to DFS</CardTitle>
          <CardDescription>Your private cloud drive, stored on Discord.</CardDescription>
        </CardHeader>

        <CardContent className="grid gap-4">
          {(reason ?? failure) && (
            <div
              role="alert"
              className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <div className="grid gap-0.5">
                <p className="font-medium">{reason?.title ?? 'Could not sign in'}</p>
                <p className="text-muted-foreground">{reason?.detail ?? failure}</p>
              </div>
            </div>
          )}

          <Button
            size="lg"
            className="h-11 bg-[#5865f2] text-base text-white hover:bg-[#4752c4]"
            disabled={pending}
            onClick={() => void handleSignIn()}
          >
            {pending ? <Spinner /> : <LogIn />}
            Continue with Discord
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Access is limited to members of the DFS Discord server with the “DFS User” role. There
            is no password to remember.
          </p>
        </CardContent>

        {mocksEnabled && (
          <CardFooter className="justify-center gap-2 border-t text-xs text-muted-foreground">
            <FlaskConical className="size-3.5" aria-hidden />
            Demo mode: sign-in is simulated and data stays in this browser.
          </CardFooter>
        )}
      </Card>
    </main>
  )
}
