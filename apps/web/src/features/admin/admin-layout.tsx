import { Outlet, useLocation } from 'react-router'
import { NavTabs } from '@/components/nav-tabs'
import { PageHeader } from '@/components/page-header'

const TABS = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/channels', label: 'Channels' },
  { to: '/admin/audit', label: 'Audit log' },
]

/** `/admin/*`: the admin area, one tab per section. */
export function AdminLayout() {
  const { pathname } = useLocation()
  // Keyed by section, so switching tabs eases the content in, while moving
  // around inside one section (the file browser) doesn't.
  const section = pathname.split('/')[2] ?? ''

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <title>Admin – DFS</title>
      <PageHeader
        title="Admin"
        description="System health, users and storage. Admins see file names and sizes, never contents."
      />
      <NavTabs label="Admin sections" tabs={TABS} />
      <div
        key={section}
        className="flex min-h-0 flex-1 animate-in flex-col fade-in-0 slide-in-from-bottom-1 motion-glide"
      >
        <Outlet />
      </div>
    </div>
  )
}
