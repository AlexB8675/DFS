import type { Device } from '@dfs/shared'
import { useQuery } from '@tanstack/react-query'
import { Laptop, Unplug } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { DeviceUsage } from '@/features/devices/device-usage'
import { errorMessage } from '@/lib/api/client'
import { devicesQuery, useRemoveDevice } from './api'

/**
 * Settings → Devices (§7.6): the backup apps paired with this account. A
 * device is added from the app, through the browser, never from here.
 */
export function DevicesCard() {
  const devices = useQuery(devicesQuery())
  const remove = useRemoveDevice()
  const [removing, setRemoving] = useState<Device | null>(null)

  function removeDevice(device: Device) {
    remove.mutate(device.id, {
      onSuccess: () => {
        toast.success(`Removed ${device.name}`)
      },
      onError: (error) => {
        toast.error('Couldn’t remove it', { description: errorMessage(error) })
      },
    })
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <CardDescription>The computers that back up to your drive.</CardDescription>
        </CardHeader>
        <CardContent>
          {devices.data ? (
            devices.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No devices. DFS Backup pairs from the app.
              </p>
            ) : (
              <ul className="grid gap-3" aria-label="Devices">
                {devices.data.map((device) => (
                  <li
                    key={device.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm"
                  >
                    <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate font-medium">{device.name}</span>
                      <span className="grid text-xs text-muted-foreground">
                        <DeviceUsage device={device} />
                      </span>
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={remove.isPending && remove.variables === device.id}
                      onClick={() => {
                        setRemoving(device)
                      }}
                    >
                      <Unplug /> Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : devices.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(devices.error)}
            </p>
          ) : (
            <Skeleton className="h-14 rounded-lg" />
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops backing up until it’s paired again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) removeDevice(removing)
              }}
            >
              Remove it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
