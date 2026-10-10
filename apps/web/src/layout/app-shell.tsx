import { useState, type CSSProperties } from 'react'
import { Outlet } from 'react-router'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { AudioBar } from '@/features/audio/audio-bar'
import { useAudioOwner } from '@/features/audio/use-audio-owner'
import { useCurrentUser } from '@/features/auth/session'
import { DragLayer } from '@/features/drag/drag-layer'
import { DriveDialogs } from '@/features/drive/dialogs/drive-dialogs'
import { useLiveEvents } from '@/features/live-events/use-live-events'
import { UploadConflictDialog } from '@/features/uploads/upload-conflict-dialog'
import { UploadPanel } from '@/features/uploads/upload-panel'
import { usePreferences } from '@/lib/preferences'
import { Header } from './header'
import { Sidebar } from './sidebar'
import { SidebarResizer } from './sidebar-resizer'

/** The signed-in layout: header, sidebar with the folder tree, and the page. */
export function AppShell() {
  const sidebarWidth = usePreferences((state) => state.sidebarWidth)
  const [navigationOpen, setNavigationOpen] = useState(false)
  useLiveEvents()
  useAudioOwner(useCurrentUser().id)

  const closeNavigation = () => {
    setNavigationOpen(false)
  }

  return (
    <div
      className="flex h-dvh flex-col bg-background text-foreground"
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      <Header
        onOpenNavigation={() => {
          setNavigationOpen(true)
        }}
      />
      <div className="flex min-h-0 flex-1">
        <aside className="relative hidden w-(--sidebar-width) shrink-0 border-r md:block">
          <Sidebar />
          <SidebarResizer />
        </aside>
        <Sheet open={navigationOpen} onOpenChange={setNavigationOpen}>
          <SheetContent side="left" className="w-72 p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Folders, shared links and trash</SheetDescription>
            <Sidebar onNavigate={closeNavigation} />
          </SheetContent>
        </Sheet>
        {/*
          Named for View Transitions: navigating animates this pane alone (lib/navigation.ts).
          A container too: pages fit their columns to this pane's width (`@min-[…]:`), not the
          screen's, which the sidebar takes a share of.
        */}
        <main className="@container flex min-w-0 flex-1 flex-col [view-transition-name:page]">
          <Outlet />
        </main>
      </div>
      <AudioBar />
      <UploadPanel />
      <UploadConflictDialog />
      <DriveDialogs />
      <DragLayer />
    </div>
  )
}
