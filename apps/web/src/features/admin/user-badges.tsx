import type { AdminUser } from '@dfs/shared'
import { Crown, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { formatFullDate } from '@/lib/format'

/**
 * Owner, where the account stands (disabled, waiting for a first sign-in, or
 * reset), and a request for a new password from the sign-in page (§7.1).
 */
export function UserBadges({ user }: { user: AdminUser }) {
  // Read once, so the badge doesn't change between renders.
  const [now] = useState(Date.now)
  const expiresAt = user.temporaryPasswordExpiresAt
  const expired = expiresAt !== null && Date.parse(expiresAt) <= now
  const until = expiresAt
    ? `Their temporary password works until ${formatFullDate(expiresAt)}.`
    : ''

  let status: { label: string; title: string; tone?: string } | null = null
  if (user.disabled) {
    status = { label: 'Disabled', title: 'Can’t sign in. Their files are kept.' }
  } else if (expired) {
    status = {
      label: 'Password expired',
      title: 'Their temporary password ran out before they used it. Reset it to send a new one.',
      tone: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
    }
  } else if (user.activatedAt === null) {
    status = { label: 'Not signed in yet', title: `Hasn’t chosen a password yet. ${until}` }
  } else if (expiresAt !== null) {
    status = {
      label: 'Password reset',
      title: `Chooses a new password at their next sign-in. ${until}`,
    }
  }

  const asked = user.passwordResetRequestedAt
  return (
    <>
      {user.isOwner && (
        <Badge variant="secondary" title="Made on the server. Always an admin.">
          <Crown /> Owner
        </Badge>
      )}
      {status && (
        <Badge variant="outline" title={status.title} className={status.tone}>
          {status.label}
        </Badge>
      )}
      {asked && !user.disabled && (
        <Badge
          variant="outline"
          title={`Asked on the sign-in page, ${formatFullDate(asked)}. Make sure it was them, then ${
            user.isOwner ? 'run dfs owner on the server' : 'give them one with Reset password'
          }.`}
          className="border-amber-500/40 text-amber-700 dark:text-amber-400"
        >
          <KeyRound /> Asked for a new password
        </Badge>
      )}
    </>
  )
}
