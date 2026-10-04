import { PASSWORD_MIN_LENGTH } from '@dfs/shared'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** The rules a new password must meet, checked off as they are typed (§7.1). */
export function PasswordRequirements({
  password,
  confirmation,
}: {
  password: string
  confirmation: string
}) {
  return (
    <ul className="grid gap-1 text-xs" aria-label="Password requirements">
      <Requirement met={password.length >= PASSWORD_MIN_LENGTH}>
        At least {PASSWORD_MIN_LENGTH} characters
      </Requirement>
      <Requirement met={password.length > 0 && password === confirmation}>
        Both passwords match
      </Requirement>
    </ul>
  )
}

/** One rule: a dot that turns into a check, with a little bounce. */
function Requirement({ met, children }: { met: boolean; children: ReactNode }) {
  return (
    <li
      className={cn(
        'flex items-center gap-2 transition-colors',
        met ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <span className="flex size-4 items-center justify-center">
        {met ? (
          <Check
            key="met"
            className="size-3.5 animate-in text-emerald-500 zoom-in-0 motion-bounce"
            aria-hidden
          />
        ) : (
          <span key="unmet" className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden />
        )}
      </span>
      {children}
      <span className="sr-only">{met ? '(done)' : '(not yet)'}</span>
    </li>
  )
}
