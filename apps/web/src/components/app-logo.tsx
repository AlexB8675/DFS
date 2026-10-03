import { cn } from '@/lib/utils'

interface AppLogoProps {
  className?: string
  /** Shows the "DFS" wordmark next to the mark. */
  withName?: boolean
}

export function AppLogo({ className, withName = false }: AppLogoProps) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="6" className="fill-primary" />
        <path
          d="M7 11.5A2.5 2.5 0 0 1 9.5 9h4.2l2.3 2.5h6.5A2.5 2.5 0 0 1 25 14v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 7 21.5z"
          className="fill-primary-foreground"
        />
      </svg>
      {withName && <span className="text-lg font-semibold tracking-tight">DFS</span>}
    </span>
  )
}
