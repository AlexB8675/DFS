import { toast } from 'sonner'

// After a deploy, a page opened before it, or restored from the browser's
// history, still runs the old app against the new API. A production page
// compares the entry script it loaded with the one the server's index.html
// names now: at startup, a newer one reloads the page at once (once per new
// version, so a stale cache can't loop it); later, the page offers a reload,
// which asks first while uploads are under way, since it would cancel them.

const CHECK_EVERY_MS = 5 * 60_000
const RELOADED_FOR = 'dfs.reloaded-for'
const TOAST_ID = 'new-version'

/** The hashed entry script an index.html loads, such as `/assets/index-BjGKEVJC.js`. */
export function entryScript(html: string): string | null {
  return /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] ?? null
}

/** Whether the server now has another app than the one this page runs. */
export function isOutdated(running: string | null, deployed: string | null): boolean {
  return running !== null && deployed !== null && running !== deployed
}

function runningEntry(): string | null {
  const script = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src*="/assets/index-"]',
  )
  return script ? new URL(script.src).pathname : null
}

async function deployedEntry(): Promise<string | null> {
  try {
    const response = await fetch('/', { cache: 'no-store' })
    return response.ok ? entryScript(await response.text()) : null
  } catch {
    // Offline, or the server restarting: the next check will tell.
    return null
  }
}

function offerReload(): void {
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

/** Watches for a newer deployed app, from startup on. Production builds only. */
export function watchForNewVersion(): void {
  const running = runningEntry()
  if (!running) return
  let offered = false

  const check = async (atStartup: boolean) => {
    if (offered) return
    const deployed = await deployedEntry()
    if (!isOutdated(running, deployed) || !deployed) return
    if (atStartup && readReloadedFor() !== deployed) {
      writeReloadedFor(deployed)
      location.reload()
      return
    }
    offered = true
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

function readReloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_FOR)
  } catch {
    return null
  }
}

function writeReloadedFor(entry: string): void {
  try {
    sessionStorage.setItem(RELOADED_FOR, entry)
  } catch {
    // Without storage, a reload loop is still bounded by the cache serving the new page.
  }
}
