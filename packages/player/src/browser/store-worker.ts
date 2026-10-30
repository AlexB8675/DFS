// The worker that the browser suite runs the store in (DESIGN.md §10.4): the app's own
// worker file will do the same, so the suite starts what the app will start.

import { serveStoreInWorker } from '../worker.ts'

serveStoreInWorker()
