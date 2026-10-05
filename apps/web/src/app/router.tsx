import { createBrowserRouter, Navigate } from 'react-router'
import { NotFoundPage, RouteError, SplashScreen } from '@/components/status-pages'
import { redirectIfSignedIn, requirePasswordChange, requireSession } from '@/features/auth/session'

/**
 * Creates the router. It is a function, not a module-level constant, because a
 * router starts loading the current route as soon as it exists, and that must
 * wait until the mock API is listening.
 *
 * Pages, and the signed-in shell itself, are split into their own chunks
 * and loaded on first visit. React Router fetches a route's code in parallel
 * with its loader (the session check), so this adds no waterfall.
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
      // After a sign-in with a temporary password, before anything else (§7.1).
      path: '/choose-password',
      loader: requirePasswordChange,
      lazy: async () => ({
        Component: (await import('@/features/auth/choose-password-page')).ChoosePasswordPage,
      }),
      hydrateFallbackElement: <SplashScreen />,
      errorElement: <RouteError />,
    },
    {
      // Public: anyone with a share link, signed in or not (D12).
      path: '/s/:token',
      lazy: async () => ({
        Component: (await import('@/features/share-view/share-page')).SharePage,
      }),
      hydrateFallbackElement: <SplashScreen />,
      errorElement: <RouteError />,
    },
    {
      path: '/',
      loader: requireSession,
      // The signed-in shell loads alongside the session check, so the login
      // and public share pages don't download it.
      lazy: async () => ({ Component: (await import('@/layout/app-shell')).AppShell }),
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
              path: 'monitoring',
              lazy: async () => ({
                Component: (await import('@/features/admin/monitoring-page')).MonitoringPage,
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
              path: 'database',
              lazy: async () => ({
                Component: (await import('@/features/admin/database-page')).DatabasePage,
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
