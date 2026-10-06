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
// - Reads and hashes overlap requests, with at most two extra buffered parts
//   and a 100 MiB plaintext budget (one oversized part may run alone).
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
  /** Extra parts to read or hash ahead of the requests in flight. */
  preparedParts: number
  /** Plaintext bytes held by preparation and requests; one larger part may run alone. */
  bufferedBytes: number
}

export const DEFAULT_LIMITS: UploadLimits = {
  requests: 8,
  partsPerFile: 4,
  sessionBatch: 64,
  sessionLowWater: 32,
  preparedParts: 2,
  bufferedBytes: 100 * 1024 * 1024,
}

const PUBLISH_MS = 100
const REFRESH_MS = 1000
const SPEED_WINDOW_MS = 5000
const ENSURE_BATCH = 500
/** Nodes per `POST /nodes/lookup`, the API's limit. */
const LOOKUP_BATCH = 500

interface Job {
  id: string
  file: File
  parentId: string
  status: UploadStatus
  session: UploadSession | null
  /** Parts the server has. */
  doneParts: Set<number>
  /** Next part to inspect; failed or aborted requests rewind it. */
  nextPart: number
  inFlight: Map<number, AbortController>
  sending: number
  uploadedBytes: number
  /** Failed tries per part, for the backoff. */
  attempts: Map<number, number>
  retryTimer: ReturnType<typeof setTimeout> | null
  completing: boolean
  /** A retry must reconcile receipts before it can send more parts. */
  checkingSession: boolean
  /** After the upload: where the file is on its way to Discord. */
  syncState: SyncState | null
  /** Node events can precede completion, but may describe an older version. */
  syncNeedsRefresh: boolean
  error: string | null
}

interface PreparedPart {
  job: Job
  session: UploadSession
  index: number
  controller: AbortController
  bytes: ArrayBuffer
  hash: string
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
  private preparing = 0
  private bufferedBytes = 0
  private readonly ready: PreparedPart[] = []
  private creatingSessions = false
  private readonly preparingSessions = new Set<Job>()
  private syncRefresh: Promise<void> | null = null

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
        nextPart: 0,
        inFlight: new Map(),
        sending: 0,
        uploadedBytes: 0,
        attempts: new Map(),
        retryTimer: null,
        completing: false,
        checkingSession: false,
        syncState: null,
        syncNeedsRefresh: false,
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
    const session = job.session
    if (session) {
      job.checkingSession = true
      try {
        const status = await this.transport.status(session.uploadId)
        if (this.jobs.get(id) !== job || job.session !== session) return
        job.doneParts = new Set(status.receivedParts)
        job.nextPart = 0
        job.uploadedBytes = status.receivedParts.reduce(
          (total, index) => total + partSize(job, status, index),
          0,
        )
      } catch (error) {
        // The session expired: start over with a new one.
        if (job.session === session && isNotFound(error)) resetSession(job)
      } finally {
        job.checkingSession = false
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
      } else if (job.status === 'uploading' && state) {
        job.syncNeedsRefresh = true
      }
    }
  }

  /** Asks for the sync state of uploaded files still syncing, after events may have been missed. */
  async refreshSyncStates(): Promise<void> {
    this.syncRefresh ??= this.checkSyncStates().finally(() => {
      this.syncRefresh = null
    })
    return this.syncRefresh
  }

  private async checkSyncStates(): Promise<void> {
    const syncing = [...this.jobs.values()].filter(
      (job) => job.status === 'done' && job.syncState === 'syncing',
    )
    // A request per 500 files, one after the other: a big upload's thousands
    // of files cost a handful of requests.
    for (let start = 0; start < syncing.length; start += LOOKUP_BATCH) {
      const batch = syncing.slice(start, start + LOOKUP_BATCH)
      const ids = batch.flatMap((job) => job.session?.nodeId ?? [])
      if (ids.length === 0) continue
      const nodes = await this.transport.nodes(ids).catch(() => [])
      const states = new Map(nodes.map((node) => [node.id, node.syncState]))
      for (const job of batch) {
        const state = job.session && states.get(job.session.nodeId)
        // A live event may have settled the file while this request was pending.
        if (state && this.jobs.get(job.id) === job && job.syncState === 'syncing') {
          job.syncState = state
          this.publish(job)
        }
      }
    }
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
    this.sendReadyParts()
    for (const job of this.active) this.feed(job)

    // Start waiting files while there is room. Large files go one at a time.
    const sendingLarge = () => this.active.some((job) => isLarge(job))
    for (let index = 0; index < this.waiting.length && this.canPrepare(0);) {
      const job = this.waiting[index]
      if (!job) break
      if (isLarge(job) && sendingLarge()) {
        index += 1
        continue
      }
      if (job.session && !this.canPrepare(partSize(job, job.session, 0))) break
      this.waiting.splice(index, 1)
      this.start(job)
    }

    this.prepareSessions()
  }

  private canPrepare(bytes: number): boolean {
    return (
      this.preparing < this.limits.requests &&
      this.preparing + this.ready.length + this.requests <
        this.limits.requests + this.limits.preparedParts &&
      (this.bufferedBytes + bytes <= this.limits.bufferedBytes || this.bufferedBytes === 0)
    )
  }

  private start(job: Job): void {
    job.status = 'uploading'
    this.active.push(job)
    this.publish(job)
    if (allPartsDone(job)) void this.finish(job)
    else this.feed(job)
  }

  /** Reads and hashes ahead, keeping at most one extra part of a large file. */
  private feed(job: Job): void {
    const { session } = job
    if (job.status !== 'uploading' || !session || job.retryTimer || job.completing) return
    const limit = isLarge(job) ? this.limits.partsPerFile : 1
    while (job.nextPart < session.chunkCount) {
      if (job.inFlight.size >= limit + Math.min(1, this.limits.preparedParts)) return
      const index = job.nextPart
      if (job.doneParts.has(index) || job.inFlight.has(index)) {
        job.nextPart += 1
        continue
      }
      if (!this.canPrepare(partSize(job, session, index))) return
      job.nextPart += 1
      this.preparePart(job, session, index)
    }
  }

  private preparePart(job: Job, session: UploadSession, index: number): void {
    const controller = new AbortController()
    job.inFlight.set(index, controller)
    const size = partSize(job, session, index)
    this.bufferedBytes += size
    this.preparing += 1
    void this.readPart(job, session, index, controller).finally(() => {
      this.preparing -= 1
      this.pump()
    })
  }

  private async readPart(
    job: Job,
    session: UploadSession,
    index: number,
    controller: AbortController,
  ): Promise<void> {
    let prepared = false
    try {
      const start = index * session.chunkSize
      const bytes = await job.file.slice(start, start + session.chunkSize).arrayBuffer()
      if (!this.canSend(job, session, controller)) return
      const hash = await sha256Hex(bytes)
      if (!this.canSend(job, session, controller)) return
      this.ready.push({ job, session, index, controller, bytes, hash })
      prepared = true
    } catch (error) {
      if (!controller.signal.aborted) this.handleFailure(job, session, index, error)
    } finally {
      if (!prepared) this.releasePart(job, session, index, controller)
    }
  }

  private canSend(job: Job, session: UploadSession, controller: AbortController): boolean {
    return (
      !controller.signal.aborted &&
      job.session === session &&
      job.status === 'uploading' &&
      job.retryTimer === null
    )
  }

  private sendReadyParts(): void {
    for (let offset = 0; offset < this.ready.length;) {
      const part = this.ready[offset]
      if (!part) break
      const { job, session, index, controller } = part
      if (
        controller.signal.aborted ||
        job.session !== session ||
        job.status !== 'uploading' ||
        job.retryTimer
      ) {
        controller.abort()
        this.ready.splice(offset, 1)
        this.releasePart(job, session, index, controller)
        continue
      }
      const limit = isLarge(job) ? this.limits.partsPerFile : 1
      if (this.requests >= this.limits.requests || job.sending >= limit) {
        offset += 1
        continue
      }
      this.ready.splice(offset, 1)
      this.requests += 1
      job.sending += 1
      void this.uploadPart(part).finally(() => {
        this.requests -= 1
        job.sending -= 1
        this.releasePart(job, session, index, controller)
        if (job.status === 'uploading' && job.inFlight.size === 0 && allPartsDone(job)) {
          void this.finish(job)
        }
        this.pump()
      })
    }
  }

  private releasePart(
    job: Job,
    session: UploadSession,
    index: number,
    controller: AbortController,
  ): void {
    this.bufferedBytes -= partSize(job, session, index)
    if (job.inFlight.get(index) === controller) job.inFlight.delete(index)
    if (job.session === session && !job.doneParts.has(index)) {
      job.nextPart = Math.min(job.nextPart, index)
    }
  }

  private async uploadPart({
    job,
    session,
    index,
    controller,
    bytes,
    hash,
  }: PreparedPart): Promise<void> {
    try {
      await this.transport.putPart(session.uploadId, index, bytes, hash, controller.signal)
      if (job.session !== session || job.doneParts.has(index)) return
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
      if (job.syncNeedsRefresh) {
        job.syncNeedsRefresh = false
        // An earlier event may have described the old current version. Check
        // after completion, and after any refresh that already took its snapshot.
        void (this.syncRefresh ?? Promise.resolve()).then(() => this.refreshSyncStates())
      }
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
    for (const job of batch) this.preparingSessions.add(job)
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
      this.preparingSessions.clear()
      this.creatingSessions = false
      this.pump()
    }
  }

  /**
   * `mkdir -p` for every folder in a dropped tree, 500 paths per request.
   * Every folder on the way is asked for, so each that may have gained a
   * subfolder is known; their listings, and the one dropped into, refresh.
   */
  private async ensureFolders(parentId: string, files: PickedFile[]): Promise<Map<string, string>> {
    const paths = [...new Set(files.flatMap((file) => prefixes(file.relativeDir)))]
    const folderIds = new Map<string, string>()
    for (let start = 0; start < paths.length; start += ENSURE_BATCH) {
      const batch = paths.slice(start, start + ENSURE_BATCH)
      const result = await this.transport.ensureFolders(parentId, batch)
      for (const path of batch) {
        const id = result[path]
        if (!Object.hasOwn(result, path) || !id) {
          throw new Error(`The upload folder “${path}” could not be prepared. Try again.`)
        }
        folderIds.set(path, id)
      }
    }
    if (folderIds.size > 0) {
      for (const id of [parentId, ...folderIds.values()]) this.refreshFolder(id)
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
    if (this.preparingSessions.has(job) || job.checkingSession) return
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
  job.nextPart = 0
  job.uploadedBytes = 0
  job.syncState = null
  job.syncNeedsRefresh = false
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

/** `a/b/c` → `a`, `a/b`, `a/b/c`; nothing for files dropped on their own. */
function prefixes(relativeDir: string): string[] {
  const names = relativeDir.split('/').filter(Boolean)
  return names.map((_, index) => names.slice(0, index + 1).join('/'))
}
