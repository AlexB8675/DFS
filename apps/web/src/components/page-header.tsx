import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
}

/** Title bar for pages that are not a folder view, matching the drive toolbar's height. */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex min-h-14 shrink-0 items-center gap-3 border-b px-4 py-2">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold">{title}</h1>
        {/* Wraps: a description cut short on a phone loses what it says (the trash's 30 days). */}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  )
}
