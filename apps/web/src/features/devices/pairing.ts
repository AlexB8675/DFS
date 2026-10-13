import { pairDeviceSchema } from '@dfs/shared'

// Pairing a backup app (§7.6): the app opens this site's `/devices/pair` in the
// browser, and the browser hands the result back to the app on this computer.

/** What the backup app asked for in the address it opened. */
export interface PairRequest {
  name: string
  /** Where the app listens, on this computer only. */
  port: number
  /** The PKCE challenge (RFC 7636, S256) the code will be tied to. */
  challenge: string
}

/** Ports below this need privileges, so no backup app listens on one. */
const FIRST_UNPRIVILEGED_PORT = 1024
const LAST_PORT = 65535

/**
 * Reads the app's request, or `null` when it isn't whole. The name and the
 * challenge are held to what `POST /devices/pair` takes, so that the page
 * never shows a request the server would refuse.
 */
export function parsePairRequest(params: URLSearchParams): PairRequest | null {
  const portText = params.get('port')
  // Digits only: `Number` would also take '1e4', '0x400' and ' 80'.
  if (portText === null || !/^\d{1,5}$/.test(portText)) return null
  const port = Number(portText)
  if (port < FIRST_UNPRIVILEGED_PORT || port > LAST_PORT) return null

  const parsed = pairDeviceSchema.safeParse({
    name: params.get('name'),
    challenge: params.get('challenge'),
  })
  if (!parsed.success) return null
  return { name: parsed.data.name, port, challenge: parsed.data.challenge }
}

/**
 * Where to send the browser once the person has decided: the app's own
 * listener, on this computer. Only a port goes in, never a host, so that
 * nothing in the address of this page can make the code travel elsewhere.
 */
export function pairingCallbackUrl(
  port: number,
  result: { code: string } | { error: 'access_denied' },
): string {
  const url = new URL('http://127.0.0.1')
  url.port = String(port)
  url.pathname = '/callback'
  if ('code' in result) url.searchParams.set('code', result.code)
  else url.searchParams.set('error', result.error)
  return url.toString()
}
