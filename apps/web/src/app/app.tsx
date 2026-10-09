import { QueryClientProvider } from '@tanstack/react-query'
import type { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AudioEngine } from '@/features/audio/audio-engine'
import { queryClient } from './query-client'

export function App({ router }: { router: ReturnType<typeof createBrowserRouter> }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        <RouterProvider router={router} />
        {/* Outside the routes: the audio bar plays on from page to page. */}
        <AudioEngine />
        <Toaster position="bottom-center" />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
