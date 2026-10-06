import { CircleCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// The cards the admin pages are made of (§9): a title, what it shows in a
// line, an action, and a quiet line for when all is well.

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string
  description: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

/** Nothing needs doing here. */
export function AllClear({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <CircleCheck className="size-4 text-status-good" aria-hidden /> {children}
    </p>
  )
}
