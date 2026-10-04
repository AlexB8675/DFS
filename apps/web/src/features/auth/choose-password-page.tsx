import { passwordSchema } from '@dfs/shared'
import { useMutation } from '@tanstack/react-query'
import { CircleAlert, KeyRound } from 'lucide-react'
import { useRef, useState, type SubmitEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { PasswordInput } from '@/components/password-input'
import { PasswordRequirements } from '@/components/password-requirements'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { errorMessage } from '@/lib/api/client'
import { shake } from '@/lib/motion'
import { prepareNavTransition } from '@/lib/navigation'
import { AuthScreen } from './auth-screen'
import { changePassword, safeNextPath, signOut, useSession } from './session'

/**
 * `/choose-password`: right after a sign-in with a temporary password, before
 * anything else (§7.1). On a first sign-in, this activates the account.
 */
export function ChoosePasswordPage() {
  const session = useSession()
  const { user } = session
  // Kept from the first render: the session stops asking once the password is set.
  const [reason] = useState(session.passwordChange)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  // A mutation, so a session that ran out meanwhile goes back to the login page.
  const change = useMutation({ mutationFn: changePassword })
  const cardRef = useRef<HTMLDivElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  function fail(message: string) {
    setError(message)
    shake(cardRef.current)
  }

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const parsed = passwordSchema.safeParse(password)
    if (!parsed.success) {
      fail(parsed.error.issues[0]?.message ?? 'Choose a longer password.')
      passwordRef.current?.focus()
      return
    }
    if (password !== confirmation) {
      fail('The two passwords don’t match.')
      return
    }
    try {
      await change.mutateAsync({ newPassword: parsed.data })
      toast.success(reason === 'activate' ? 'Your account is ready' : 'Your new password is set')
      await navigate(safeNextPath(searchParams.get('next')), {
        replace: true,
        viewTransition: prepareNavTransition('section'),
      })
    } catch (failure) {
      fail(errorMessage(failure))
    }
  }

  return (
    <AuthScreen>
      <title>Choose a password – DFS</title>
      <Card
        ref={cardRef}
        className="relative w-full max-w-sm animate-in duration-300 ease-smooth fade-in-0 slide-in-from-bottom-2"
      >
        <CardHeader className="items-center text-center">
          <span className="mx-auto mb-2 flex size-12 animate-in items-center justify-center rounded-full bg-primary/15 zoom-in-50 motion-bounce">
            <KeyRound className="size-5 text-primary" aria-hidden />
          </span>
          <CardTitle className="text-xl">
            {reason === 'activate' ? `Welcome, ${user.displayName}` : 'Choose a new password'}
          </CardTitle>
          <CardDescription>
            {reason === 'activate' ? (
              <>
                Choose a password to finish setting up your account. You’ll sign in with it and your
                username, <span className="font-mono text-foreground">{user.username}</span>.
              </>
            ) : (
              'An admin reset your password. Choose a new one to continue.'
            )}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form className="grid gap-4" noValidate onSubmit={(event) => void handleSubmit(event)}>
            {/* Lets password managers save the new password under the right account. */}
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={user.username}
              readOnly
              hidden
            />

            {error && (
              <div
                role="alert"
                className="flex animate-in gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm fade-in-0 zoom-in-95 motion-spring"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                <p>{error}</p>
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="new-password">New password</Label>
              <PasswordInput
                ref={passwordRef}
                id="new-password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                }}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Type it again</Label>
              <PasswordInput
                id="confirm-password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => {
                  setConfirmation(event.target.value)
                }}
              />
            </div>

            <PasswordRequirements password={password} confirmation={confirmation} />

            <Button type="submit" size="lg" className="mt-1 h-10" disabled={change.isPending}>
              {change.isPending && <Spinner />}
              {reason === 'activate' ? 'Finish setup' : 'Save password'}
            </Button>
          </form>
        </CardContent>

        <CardFooter className="justify-center border-t text-xs text-muted-foreground">
          Not {user.displayName}?
          <Button
            variant="link"
            size="sm"
            className="h-auto px-1 text-xs"
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
        </CardFooter>
      </Card>
    </AuthScreen>
  )
}
