import { createBrowserRouter, Navigate } from 'react-router'
import { NotFoundPage, RouteError, SplashScreen } from '@/components/status-pages'
import { LoginPage } from '@/features/auth/login-page'
import { redirectIfSignedIn, requireSession } from '@/features/auth/session'
import { DrivePage } from '@/features/drive/drive-page'
import { SearchPage } from '@/features/search/search-page'
import { SettingsPage } from '@/features/settings/settings-page'
import { SharesPage } from '@/features/shares/shares-page'
import { TrashPage } from '@/features/trash/trash-page'
import { AppShell } from '@/layout/app-shell'

/**
 * Creates the router. It is a function, not a module-level constant, because a
 * router starts loading the current route as soon as it exists, and that must
 * wait until the mock API is listening.
 */
export function createAppRouter() {
  return createBrowserRouter([
    {
      path: '/login',
      loader: redirectIfSignedIn,
      element: <LoginPage />,
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
        { path: 'drive', element: <DrivePage /> },
        { path: 'drive/:folderId', element: <DrivePage /> },
        { path: 'search', element: <SearchPage /> },
        { path: 'shared', element: <SharesPage /> },
        { path: 'trash', element: <TrashPage /> },
        { path: 'settings', element: <SettingsPage /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ])
}
