import { useEffect } from 'react'
import { forgetDriveTracks } from './engine'
import { useAudioStore } from './store'

/** Another user's drive files leave the queue when this one signs in (§10.4). */
export function useAudioOwner(userId: string): void {
  useEffect(() => {
    const { ownerId } = useAudioStore.getState()
    if (ownerId === userId) return
    if (ownerId !== null) forgetDriveTracks()
    useAudioStore.setState({ ownerId: userId })
  }, [userId])
}
