import { releaseSchema } from '@dfs/shared'
import { toast } from 'sonner'
import { appRelease } from '@/lib/env'

// After a deploy, a page opened before it, or restored from the browser's
// history, still runs the old app against the new API. Every API answer says
// what is deployed (`X-DFS-Version`), and a production page compares that
// with the version it was built as: at startup, a newer one reloads the page
// at once (once per version, so a stale cache can't loop it); later, the
// page offers a reload, which asks first while uploads are under way, since
// it would cancel them. A page that makes no requests asks `/api/version`
// now and then. One that can't load a part of itself, which the deploy
// removed, reloads into the new version at once (`RouteError`).

const CHECK_EVERY_MS = 5 * 60_000
const RELOADED_FOR = 'dfs.reloaded-for'
const TOAST_ID = 'new-version'

let offered = false

/** Whether the server runs another version than `running`. A development build never compares. */
export function isOutdated(running: string, deployed: string | null): deployed is string {
  return running !== 'dev' && deployed !== null && deployed !== '' && deployed !== running
}

/**
 * Whether an error is a part of the app failing to load: a module the
 * browser couldn't fetch, as each browser words it.
 */
export function isMissingModule(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /dynamically imported module|importing a module script failed/i.test(error.message)
  )
}

/** Each API answer's `X-DFS-Version`: a newer deploy is offered at once. */
export function noticeDeployed(version: string | null): void {
  if (isOutdated(appRelease.version, version)) offerReload()
}

/**
 * Reloads into the version deployed now if it is newer, and returns whether
 * it does: for a page that finds a part of itself gone.
 */
export async function reloadIfOutdated(): Promise<boolean> {
  const deployed = await deployedVersion()
  return isOutdated(appRelease.version, deployed) && reload(deployed)
}

/** Watches for a newer deploy, from startup on. Production builds only. */
export function watchForNewVersion(): void {
  if (appRelease.version === 'dev') return
  const check = async (atStartup: boolean) => {
    if (offered) return
    const deployed = await deployedVersion()
    if (!isOutdated(appRelease.version, deployed)) return
    if (atStartup && reload(deployed)) return
    offerReload()
  }

  void check(true)
  setInterval(() => void check(false), CHECK_EVERY_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check(false)
  })
  // A page restored from the back/forward cache keeps its old app in memory.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void check(false)
  })
}

async function deployedVersion(): Promise<string | null> {
  try {
    const response = await fetch('/api/version', { cache: 'no-store' })
    if (!response.ok) return null
    const release = releaseSchema.safeParse(await response.json())
    return release.success ? release.data.version : null
  } catch {
    // Offline, or the server restarting: the next check will tell.
    return null
  }
}

/** Reloads into `deployed`, unless this tab did already: then a stale cache serves the old app, and reloading again would loop. */
function reload(deployed: string): boolean {
  if (readReloadedFor() === deployed) return false
  writeReloadedFor(deployed)
  location.reload()
  return true
}

function offerReload(): void {
  if (offered) return
  offered = true
  toast('DFS has been updated', {
    id: TOAST_ID,
    description: 'Reload to use the new version.',
    duration: Infinity,
    action: {
      label: 'Reload',
      onClick: () => {
        location.reload()
      },
    },
  })
}

function readReloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_FOR)
  } catch {
    return null
  }
}

function writeReloadedFor(version: string): void {
  try {
    sessionStorage.setItem(RELOADED_FOR, version)
  } catch {
    // Without storage, a reload loop is still bounded by the cache serving the new page.
  }
}
