import { Menu } from 'lucide-react'
import { Link } from 'react-router'
import { AppLogo } from '@/components/app-logo'
import { Button } from '@/components/ui/button'
import { transitionLinkProps } from '@/lib/navigation'
import { LiveIndicator } from './live-indicator'
import { SearchBox } from './search-box'
import { ThemeMenu } from './theme-menu'
import { UserMenu } from './user-menu'

interface HeaderProps {
  onOpenNavigation: () => void
}

export function Header({ onOpenNavigation }: HeaderProps) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Open navigation"
        onClick={onOpenNavigation}
      >
        <Menu />
      </Button>
      {/* Matches the sidebar's width, so the search box lines up with the content. */}
      <Link
        to="/drive"
        {...transitionLinkProps('section')}
        aria-label="DFS home"
        className="flex shrink-0 items-center rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-[calc(var(--sidebar-width)-0.75rem)]"
      >
        <AppLogo withName />
      </Link>
      <SearchBox className="min-w-0 flex-1 md:max-w-2xl" />
      <div className="ml-auto flex items-center gap-1">
        <LiveIndicator />
        <ThemeMenu />
        <UserMenu />
      </div>
    </header>
  )
}
