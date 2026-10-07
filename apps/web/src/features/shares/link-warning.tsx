import { Link2 } from 'lucide-react'
import type { ReactNode } from 'react'

/** A notice that an action changes what share links serve, or stops them (§7.5). */
export function LinkWarning({ children }: { children: ReactNode }) {
  return (
    <p
      role="note"
      className="flex gap-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
    >
      <Link2 className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  )
}
