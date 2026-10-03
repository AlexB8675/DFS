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
