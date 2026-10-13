import { pairingCodeSchema } from '@dfs/shared'
import { useMutation } from '@tanstack/react-query'
import { CircleAlert, HardDriveUpload, Link2Off } from 'lucide-react'
import { useRef } from 'react'
import { useSearchParams } from 'react-router'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { apiSend, errorMessage } from '@/lib/api/client'
import { shake } from '@/lib/motion'
import { pairingCallbackUrl, parsePairRequest, type PairRequest } from './pairing'

const CARD_CLASS =
  'w-full max-w-md animate-in justify-self-center duration-300 ease-smooth fade-in-0 slide-in-from-bottom-2'

/**
 * `/devices/pair`: where a backup app sends the browser to be allowed in
 * (§7.6). The route sits behind the session check, so a signed-out browser
 * signs in first and comes back here with the address intact. The page never
 * goes anywhere but the app's own listener on this computer: the address
 * holds a port, never a host.
 */
export function PairPage() {
  const [searchParams] = useSearchParams()
  const request = parsePairRequest(searchParams)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <title>Pair a device – DFS</title>
      <PageHeader title="Pair a device" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-2xl p-4 sm:p-6">
          {request ? <Approval request={request} /> : <Incomplete />}
        </div>
      </div>
    </div>
  )
}

/** The address was cut short or made up: there is no app to hand a code to. */
function Incomplete() {
  return (
    <Card className={CARD_CLASS}>
      <CardHeader>
        <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-muted">
          <Link2Off className="size-5 text-muted-foreground" aria-hidden />
        </span>
        <CardTitle>Can’t pair this device</CardTitle>
        <CardDescription>
          This pairing link is incomplete. Start pairing again from DFS Backup.
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

function Approval({ request }: { request: PairRequest }) {
  const { name, port, challenge } = request
  const cardRef = useRef<HTMLDivElement>(null)
  // A top-level navigation, not `fetch`: the site may only connect to itself, and
  // the app's listener is on this computer. Success keeps the buttons off, so a
  // second click can't ask for a second code while the browser is on its way.
  const pair = useMutation({
    mutationFn: () => apiSend('POST', '/devices/pair', { name, challenge }, pairingCodeSchema),
    onSuccess: ({ code }) => {
      window.location.assign(pairingCallbackUrl(port, { code }))
    },
    onError: () => {
      shake(cardRef.current)
    },
  })
  const busy = pair.isPending || pair.isSuccess

  return (
    <Card ref={cardRef} className={CARD_CLASS}>
      <CardHeader>
        <span className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary/15">
          <HardDriveUpload className="size-5 text-primary" aria-hidden />
        </span>
        <CardTitle className="text-base break-words">Let {name} back up to your drive?</CardTitle>
        <CardDescription>
          It will be able to back up this computer’s folders while it stays paired. You can remove
          it in Settings → Devices.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {pair.isError && (
          <div
            role="alert"
            className="flex animate-in gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm fade-in-0 zoom-in-95 motion-spring"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <p>{errorMessage(pair.error)}</p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() => {
              pair.mutate()
            }}
          >
            {busy && <Spinner />} Allow
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              window.location.assign(pairingCallbackUrl(port, { error: 'access_denied' }))
            }}
          >
            Deny
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
