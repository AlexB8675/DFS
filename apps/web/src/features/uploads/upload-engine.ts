import type { SyncState, UploadSession } from '@dfs/shared'
import { queryClient } from '@/app/query-client'
import { invalidateListings } from '@/features/drive/cache'
import { markFresh } from '@/features/drive/list-motion'
import { subscribeToResync, subscribeToSyncs } from '@/features/live-events/live-events'
import { ApiError, errorMessage } from '@/lib/api/client'
import type { PickedFile } from './picked-files'
import { isRetryable, MAX_ATTEMPTS, retryDelayMs } from './retry'
import { isActive, useUploadStore, type UploadItem, type UploadStatus } from './upload-store'
import { httpTransport, type UploadTransport } from './upload-transport'

// Runs uploads as described in DESIGN.md §6.1 and §10.2:
//
// - Sessions are created a little ahead of time, 64 per `POST /uploads/batch`,
//   so a small file costs one more request: its single PUT, which completes it.
// - Up to 8 requests are in flight. Large files go one at a time, each with
//   up to 4 parts in parallel; small files fill the other slots.
// - A failed request is retried with exponential backoff, honouring
//   `Retry-After` (503 when the server's staging area is full).
// - Pause keeps the session; resuming sends only the parts the server lacks.
//
// The engine keeps the authoritative state here and publishes it to the
// upload store about ten times a second, so a big batch doesn't re-render
// the panel for every part.

export interface UploadLimits {
  /** Requests in flight at once, across all files. */
  requests: number
  /** Parts of one large file in flight at once. */
  partsPerFile: number
  /** Sessions per `POST /uploads/batch` (the API allows up to 500). */
  sessionBatch: number
  /** The next batch of sessions is created when fewer than this many are ready. */
  sessionLowWater: number
}

export const DEFAULT_LIMITS: UploadLimits = {
  requests: 8,
  partsPerFile: 4,
  sessionBatch: 64,
  sessionLowWater: 32,
}

const PUBLISH_MS = 100
const REFRESH_MS = 1000
const SPEED_WINDOW_MS = 5000
const ENSURE_BATCH = 500

interface Job {
  id: string
  file: File
  parentId: string
  status: UploadStatus
  session: UploadSession | null
  /** Parts the server has. */
  doneParts: Set<number>
  inFlight: Map<number, AbortController>
  uploadedBytes: number
  /** Failed tries per part, for the backoff. */
  attempts: Map<number, number>
  retryTimer: ReturnType<typeof setTimeout> | null
  completing: boolean
  /** After the upload: where the file is on its way to Discord. */
  syncState: SyncState | null
  error: string | null
}

export class UploadEngine {
  private readonly transport: UploadTransport
  private readonly limits: UploadLimits
  private readonly jobs = new Map<string, Job>()
  /** Jobs that still need a session, in order. */
  private needSession: Job[] = []
  /** Jobs with a session, waiting for a free slot. */
  private waiting: Job[] = []
  /** Jobs sending parts. */
  private active: Job[] = []
  private requests = 0
  private creatingSessions = false

  private readonly changes = new Map<string, Partial<UploadItem>>()
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private speedTimer: ReturnType<typeof setTimeout> | undefined
  private readonly foldersToRefresh = new Set<string>()
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private samples: { at: number; bytes: number }[] = []

  constructor(transport: UploadTransport = httpTransport, limits: UploadLimits = DEFAULT_LIMITS) {
    this.transport = transport
    this.limits = limits
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  /** Queues files for upload into `parentId`, creating any folders they came from first. */
  async enqueue(parentId: string, files: PickedFile[]): Promise<void> {
    if (files.length === 0) return
    const folderIds = await this.ensureFolders(parentId, files)
    const items: UploadItem[] = []
    for (const { file, relativeDir } of files) {
      const job: Job = {
        id: crypto.randomUUID(),
        file,
        parentId: folderIds.get(relativeDir) ?? parentId,
        status: 'queued',
        session: null,
        doneParts: new Set(),
        inFlight: new Map(),
        uploadedBytes: 0,
        attempts: new Map(),
        retryTimer: null,
        completing: false,
        syncState: null,
        error: null,
      }
      this.jobs.set(job.id, job)
      this.needSession.push(job)
      items.push({ ...toItem(job), id: job.id, file, parentId: job.parentId })
    }
    useUploadStore.getState().add(items)
    this.pump()
  }

  pause(id: string): void {
    this.pauseJobs([this.jobs.get(id)])
  }

  pauseAll(): void {
    this.pauseJobs([...this.jobs.values()])
  }

  resume(id: string): void {
    this.resumeJobs([this.jobs.get(id)])
  }

  resumeAll(): void {
    this.resumeJobs([...this.jobs.values()])
  }

  /** Tries a failed upload again, sending only the parts the server doesn't have. */
  async retry(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (job?.status !== 'failed') return
    job.status = 'queued'
    job.error = null
    job.attempts.clear()
    this.publish(job)
    if (job.session) {
      try {
        const status = await this.transport.status(job.session.uploadId)
        job.doneParts = new Set(status.receivedParts)
        job.uploadedBytes = status.receivedParts.reduce(
          (total, index) => total + partSize(job, status, index),
          0,
        )
      } catch (error) {
        // The session expired: start over with a new one.
        if (isNotFound(error)) resetSession(job)
      }
    }
    // Cancelled or cleared while asking the server.
    if (this.jobs.get(id)?.status !== 'queued') return
    this.requeue(job)
    this.publish(job)
    this.pump()
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.cancelJobs([job])
  }

  cancelAll(): void {
    this.cancelJobs([...this.jobs.values()])
  }

  /** Drops finished, failed and canceled uploads from the list (and failed sessions from the server). */
  clearFinished(): void {
    const removed = new Set<string>()
    for (const job of this.jobs.values()) {
      if (isActive(job.status) || job.status === 'paused') continue
      if (job.status === 'failed') this.dropSession(job)
      removed.add(job.id)
      this.jobs.delete(job.id)
      this.changes.delete(job.id)
    }
    useUploadStore.getState().remove(removed)
  }

  /** Live events reported new sync states: stored on Discord, or failed or lost on the way. */
  markSyncStates(states: ReadonlyMap<string, SyncState>): void {
    for (const job of this.jobs.values()) {
      const state = job.session && states.get(job.session.nodeId)
      if (job.status === 'done' && state && state !== job.syncState) {
        job.syncState = state
        this.publish(job)
      }
    }
  }

  /** Asks for the sync state of uploaded files still syncing, after events may have been missed. */
  async refreshSyncStates(): Promise<void> {
    const syncing = [...this.jobs.values()]
      .filter((job) => job.status === 'done' && job.syncState === 'syncing')
      .slice(0, 200)
    const states = await Promise.all(
      syncing.map(async (job) => {
        const nodeId = job.session?.nodeId
        const node = nodeId ? await this.transport.node(nodeId).catch(() => null) : null
        return node?.syncState && nodeId ? ([[nodeId, node.syncState]] as const) : []
      }),
    )
    this.markSyncStates(new Map(states.flat()))
  }

  /** Retries now whatever is waiting out a backoff, e.g. when the network comes back. */
  retryNow(): void {
    for (const job of this.active) {
      if (job.retryTimer === null) continue
      clearTimeout(job.retryTimer)
      job.retryTimer = null
      this.publish(job)
    }
    this.pump()
  }

  // ── Scheduling ───────────────────────────────────────────────────────────

  private pump(): void {
    for (const job of this.active) this.feed(job)

    // Start waiting files while there is room. Large files go one at a time.
    const sendingLarge = () => this.active.some((job) => isLarge(job))
    for (let index = 0; index < this.waiting.length && this.hasRoom();) {
      const job = this.waiting[index]
      if (!job) break
      if (isLarge(job) && sendingLarge()) {
        index += 1
        continue
      }
      this.waiting.splice(index, 1)
      this.start(job)
    }

    this.prepareSessions()
  }

  private hasRoom(): boolean {
    return this.requests < this.limits.requests
  }

  private start(job: Job): void {
    job.status = 'uploading'
    this.active.push(job)
    this.publish(job)
    if (allPartsDone(job)) void this.finish(job)
    else this.feed(job)
  }

  /** Sends more parts of `job`, up to the limits. */
  private feed(job: Job): void {
    const { session } = job
    if (job.status !== 'uploading' || !session || job.retryTimer || job.completing) return
    const limit = isLarge(job) ? this.limits.partsPerFile : 1
    for (let index = 0; index < session.chunkCount; index += 1) {
      if (job.inFlight.size >= limit || !this.hasRoom()) return
      if (!job.doneParts.has(index) && !job.inFlight.has(index)) this.sendPart(job, session, index)
    }
  }

  private sendPart(job: Job, session: UploadSession, index: number): void {
    const controller = new AbortController()
    job.inFlight.set(index, controller)
    this.requests += 1
    void this.uploadPart(job, session, index, controller).finally(() => {
      job.inFlight.delete(index)
      this.requests -= 1
      if (job.status === 'uploading' && job.inFlight.size === 0 && allPartsDone(job)) {
        void this.finish(job)
      }
      this.pump()
    })
  }

  private async uploadPart(
    job: Job,
    session: UploadSession,
    index: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      const start = index * session.chunkSize
      const bytes = await job.file.slice(start, start + session.chunkSize).arrayBuffer()
      const hash = await sha256Hex(bytes)
      if (controller.signal.aborted) return
      await this.transport.putPart(session.uploadId, index, bytes, hash, controller.signal)
      job.doneParts.add(index)
      job.uploadedBytes += bytes.byteLength
      job.attempts.delete(index)
      this.recordSpeed(bytes.byteLength)
      this.publish(job)
    } catch (error) {
      if (!controller.signal.aborted) this.handleFailure(job, session, index, error)
    }
  }

  private handleFailure(job: Job, session: UploadSession, index: number, error: unknown): void {
    if (job.status !== 'uploading') return
    // Sessions answer until they expire, also once complete, and a part sent
    // again is accepted (§6.1), so a lost response is simply retried. A 404
    // means the session expired.
    if (isNotFound(error)) {
      resetSession(job)
      this.fail(job, 'The upload expired. Retry to start it again.')
      return
    }
    const attempts = (job.attempts.get(index) ?? 0) + 1
    if (isRetryable(error) && attempts <= MAX_ATTEMPTS) {
      job.attempts.set(index, attempts)
      this.clearRetry(job)
      job.retryTimer = setTimeout(
        () => {
          job.retryTimer = null
          this.publish(job)
          this.pump()
        },
        retryDelayMs(attempts, error),
      )
      this.publish(job)
      return
    }
    this.fail(job, errorMessage(error))
  }

  private async finish(job: Job): Promise<void> {
    const { session } = job
    if (job.completing || !session) return
    job.completing = true
    try {
      // Single-part uploads complete on their own when the part arrives (§6.1).
      if (session.chunkCount !== 1) {
        await this.withRetries(() => this.transport.complete(session.uploadId))
      }
      if (job.status !== 'uploading') return
      job.status = 'done'
      job.syncState = 'syncing'
      job.uploadedBytes = job.file.size
      this.active = this.active.filter((candidate) => candidate !== job)
      this.publish(job)
      this.refreshFolder(job.parentId)
    } catch (error) {
      if (job.status === 'uploading') this.fail(job, errorMessage(error))
    } finally {
      job.completing = false
      this.pump()
    }
  }

  private fail(job: Job, message: string): void {
    this.stop(job)
    job.status = 'failed'
    job.error = message
    this.publish(job)
    this.refreshFolder(job.parentId)
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /** Creates the next batch of sessions when the ready ones run low. */
  private prepareSessions(): void {
    if (this.creatingSessions || this.needSession.length === 0) return
    if (this.waiting.length >= this.limits.sessionLowWater) return
    const batch = this.needSession.splice(0, this.limits.sessionBatch)
    void this.createSessions(batch)
  }

  private async createSessions(batch: Job[]): Promise<void> {
    this.creatingSessions = true
    try {
      const results = await this.withRetries(() =>
        this.transport.createSessions(
          batch.map((job) => ({
            parentId: job.parentId,
            name: job.file.name,
            sizeBytes: job.file.size,
            mimeType: job.file.type || 'application/octet-stream',
          })),
        ),
      )
      batch.forEach((job, index) => {
        const result = results[index]
        if (!result?.ok) {
          if (job.status === 'queued') this.fail(job, result?.error.message ?? 'Could not start.')
          return
        }
        job.session = result.session
        if (job.status === 'canceled') this.dropSession(job)
        else if (job.status === 'queued') this.waiting.push(job)
        // A job paused meanwhile keeps its session for when it resumes.
      })
      // The new files show up in their folders right away, marked as uploading.
      // New files pop in; a new version of a file already listed doesn't (D20).
      markFresh(
        batch.flatMap((job) =>
          job.session && !job.session.isNewVersion ? [job.session.nodeId] : [],
        ),
      )
      for (const job of batch) this.refreshFolder(job.parentId)
    } catch (error) {
      for (const job of batch) if (job.status === 'queued') this.fail(job, errorMessage(error))
    } finally {
      this.creatingSessions = false
      this.pump()
    }
  }

  /** `mkdir -p` for every folder in a dropped tree, 500 paths per request. */
  private async ensureFolders(parentId: string, files: PickedFile[]): Promise<Map<string, string>> {
    const paths = [...new Set(files.map((file) => file.relativeDir).filter(Boolean))]
    const folderIds = new Map<string, string>()
    for (let start = 0; start < paths.length; start += ENSURE_BATCH) {
      const result = await this.transport.ensureFolders(
        parentId,
        paths.slice(start, start + ENSURE_BATCH),
      )
      for (const [path, id] of Object.entries(result)) folderIds.set(path, id)
    }
    return folderIds
  }

  /** Deletes the server side of an upload that won't finish, so no stuck file is left behind. */
  private dropSession(job: Job): void {
    if (!job.session) return
    void this.transport.cancel(job.session.uploadId).catch(ignore)
    job.session = null
    this.refreshFolder(job.parentId)
  }

  // ── Pause, resume, cancel ────────────────────────────────────────────────

  private pauseJobs(jobs: (Job | undefined)[]): void {
    const paused = new Set<Job>()
    for (const job of jobs) {
      if (!job || !isActive(job.status)) continue
      this.abortParts(job)
      this.clearRetry(job)
      job.status = 'paused'
      paused.add(job)
      this.publish(job)
    }
    this.removeFromQueues(paused)
    this.pump()
  }

  private resumeJobs(jobs: (Job | undefined)[]): void {
    // In reverse, so requeuing each at the front keeps their order.
    for (const job of jobs.toReversed()) {
      if (job?.status !== 'paused') continue
      job.status = 'queued'
      job.attempts.clear()
      this.requeue(job)
      this.publish(job)
    }
    this.pump()
  }

  private cancelJobs(jobs: Job[]): void {
    const canceled = new Set<Job>()
    for (const job of jobs) {
      if (job.status === 'done' || job.status === 'canceled') continue
      this.abortParts(job)
      this.clearRetry(job)
      job.status = 'canceled'
      this.dropSession(job)
      canceled.add(job)
      this.publish(job)
    }
    this.removeFromQueues(canceled)
    this.pump()
  }

  /** Puts a job back at the front of the line it belongs in. */
  private requeue(job: Job): void {
    if (job.session) this.waiting.unshift(job)
    else this.needSession.unshift(job)
  }

  private stop(job: Job): void {
    this.abortParts(job)
    this.clearRetry(job)
    this.removeFromQueues(new Set([job]))
  }

  private removeFromQueues(jobs: ReadonlySet<Job>): void {
    if (jobs.size === 0) return
    const keep = (job: Job) => !jobs.has(job)
    this.needSession = this.needSession.filter(keep)
    this.waiting = this.waiting.filter(keep)
    this.active = this.active.filter(keep)
  }

  private abortParts(job: Job): void {
    for (const controller of job.inFlight.values()) controller.abort()
  }

  private clearRetry(job: Job): void {
    if (job.retryTimer === null) return
    clearTimeout(job.retryTimer)
    job.retryTimer = null
  }

  private async withRetries<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work()
      } catch (error) {
        if (!isRetryable(error) || attempt > MAX_ATTEMPTS) throw error
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt, error)))
      }
    }
  }

  // ── Publishing ───────────────────────────────────────────────────────────

  private publish(job: Job): void {
    this.changes.set(job.id, toItem(job))
    this.publishTimer ??= setTimeout(() => {
      this.flush()
    }, PUBLISH_MS)
  }

  private flush(): void {
    clearTimeout(this.publishTimer)
    clearTimeout(this.speedTimer)
    this.publishTimer = undefined
    this.speedTimer = undefined
    const changes = new Map(this.changes)
    this.changes.clear()
    useUploadStore.getState().apply(changes, this.speed())
    // Keep the speed current while sending, even when no part finishes for a
    // while. A separate timer, so it never delays a status change.
    if (this.active.length > 0) {
      this.speedTimer = setTimeout(() => {
        this.flush()
      }, REFRESH_MS)
    }
  }

  private recordSpeed(bytes: number): void {
    this.samples.push({ at: Date.now(), bytes })
  }

  /** Bytes per second over the last few seconds. */
  private speed(): number {
    const now = Date.now()
    this.samples = this.samples.filter((sample) => now - sample.at < SPEED_WINDOW_MS)
    const [oldest] = this.samples
    if (!oldest) return 0
    const bytes = this.samples.reduce((total, sample) => total + sample.bytes, 0)
    return (bytes * 1000) / Math.max(1000, now - oldest.at)
  }

  /** Refreshes the listings of folders that gained files, at most once a second. */
  private refreshFolder(folderId: string): void {
    this.foldersToRefresh.add(folderId)
    this.refreshTimer ??= setTimeout(() => {
      this.refreshTimer = undefined
      const folders = [...this.foldersToRefresh]
      this.foldersToRefresh.clear()
      void invalidateListings(folders)
      // The quota changes once per batch, not per file (§6.1).
      if (!this.busy()) void queryClient.invalidateQueries({ queryKey: ['session'] })
    }, REFRESH_MS)
  }

  private busy(): boolean {
    return (
      this.creatingSessions ||
      this.active.length > 0 ||
      this.waiting.length > 0 ||
      this.needSession.length > 0
    )
  }
}

function toItem(job: Job): Omit<UploadItem, 'id' | 'file' | 'parentId'> {
  return {
    status: job.status,
    uploadedBytes: job.uploadedBytes,
    nodeId: job.session?.nodeId ?? null,
    syncState: job.syncState,
    retrying: job.retryTimer !== null,
    error: job.error,
  }
}

function isLarge(job: Job): boolean {
  return (job.session?.chunkCount ?? 0) > 1
}

function allPartsDone(job: Job): boolean {
  return job.session !== null && job.doneParts.size >= job.session.chunkCount
}

function resetSession(job: Job): void {
  job.session = null
  job.doneParts = new Set()
  job.uploadedBytes = 0
}

function partSize(job: Job, session: UploadSession, index: number): number {
  const start = index * session.chunkSize
  return Math.max(0, Math.min(session.chunkSize, job.file.size - start))
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}

function ignore(): void {
  // Best effort: an orphaned session expires on its own after 24 h (§6.1).
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// ── The app's engine ─────────────────────────────────────────────────────────

export const uploadEngine = new UploadEngine()

subscribeToSyncs((nodes) => {
  uploadEngine.markSyncStates(new Map(nodes.map((node) => [node.id, node.syncState])))
})
subscribeToResync(() => void uploadEngine.refreshSyncStates())

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    uploadEngine.retryNow()
  })
}

export function enqueueUploads(parentId: string, files: PickedFile[]): Promise<void> {
  return uploadEngine.enqueue(parentId, files)
}
