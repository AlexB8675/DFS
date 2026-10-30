// The worker that serves a play's store (DESIGN.md §10.4; the iron-clad spec §4.7). The
// page makes it with `makeStoreWorker` (`play-store.ts`); Vite builds this file as a
// module of its own under `assets/`, so that the page's CSP (`script-src 'self'`, no
// `blob:`) lets it run.

import { serveStoreInWorker } from '@dfs/player/worker'

serveStoreInWorker()
