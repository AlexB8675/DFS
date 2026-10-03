import { useEffect } from 'react'
import { startLiveEvents } from './live-events'

/** Keeps the app's data fresh from the server's live events while mounted. */
export function useLiveEvents(): void {
  useEffect(() => startLiveEvents(), [])
}
