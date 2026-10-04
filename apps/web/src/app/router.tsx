import { createBrowserRouter, Navigate } from 'react-router'
import { NotFoundPage, RouteError, SplashScreen } from '@/components/status-pages'
import { redirectIfSignedIn, requireSession } from '@/features/auth/session'
import { AppShell } from '@/layout/app-shell'

/**
 * Creates the router. It is a function, not a module-level constant, because a
 * router starts loading the current route as soon as it exists, and that must
 * wait until the mock API is listening.
 *
 * Pages are split into their own chunks and loaded on first visit. React
 * Router fetches a page's code in parallel with the session check, so this
 * adds no waterfall.
 */
export function createAppRouter() {
  return createBrowserRouter([
    {
      path: '/login',
      loader: redirectIfSignedIn,
      lazy: async () => ({ Component: (await import('@/features/auth/login-page')).LoginPage }),
      hydrateFallbackElement: <SplashScreen />,
      errorElement: <RouteError />,
    },
    {
      path: '/',
      loader: requireSession,
      element: <AppShell />,
      hydrateFallbackElement: <SplashScreen />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <Navigate to="/drive" replace /> },
        { path: 'drive', lazy: drivePage },
        { path: 'drive/:folderId', lazy: drivePage },
        {
          path: 'search',
          lazy: async () => ({
            Component: (await import('@/features/search/search-page')).SearchPage,
          }),
        },
        {
          path: 'shared',
          lazy: async () => ({
            Component: (await import('@/features/shares/shares-page')).SharesPage,
          }),
        },
        {
          path: 'trash',
          lazy: async () => ({
            Component: (await import('@/features/trash/trash-page')).TrashPage,
          }),
        },
        {
          path: 'admin',
          // Only the role check; the pages load with the layout's chunk.
          loader: async (args) => (await import('@/features/admin/api')).requireAdmin(args),
          lazy: async () => ({
            Component: (await import('@/features/admin/admin-layout')).AdminLayout,
          }),
          errorElement: <NotFoundPage />,
          children: [
            {
              index: true,
              lazy: async () => ({
                Component: (await import('@/features/admin/overview-page')).OverviewPage,
              }),
            },
            {
              path: 'users',
              lazy: async () => ({
                Component: (await import('@/features/admin/users-page')).UsersPage,
              }),
            },
            { path: 'users/:userId', lazy: adminUserPage },
            { path: 'users/:userId/folders/:folderId', lazy: adminUserPage },
            {
              path: 'channels',
              lazy: async () => ({
                Component: (await import('@/features/admin/channels-page')).ChannelsPage,
              }),
            },
            {
              path: 'audit',
              lazy: async () => ({
                Component: (await import('@/features/admin/audit-page')).AuditPage,
              }),
            },
          ],
        },
        {
          path: 'settings',
          lazy: async () => ({
            Component: (await import('@/features/settings/settings-page')).SettingsPage,
          }),
        },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ])
}

async function drivePage() {
  return { Component: (await import('@/features/drive/drive-page')).DrivePage }
}

async function adminUserPage() {
  return { Component: (await import('@/features/admin/user-page')).UserPage }
}
