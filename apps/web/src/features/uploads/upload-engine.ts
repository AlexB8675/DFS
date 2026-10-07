import { splitExtension, type ExistingFile, type SyncState, type UploadSession } from '@dfs/shared'
import { queryClient } from '@/app/query-client'
import { invalidateListings } from '@/features/drive/cache'
import { markFresh } from '@/features/drive/list-motion'
import { subscribeToResync, subscribeToSyncs } from '@/features/live-events/live-events'
import { ApiError, errorMessage } from '@/lib/api/client'
import type { PickedFile } from './picked-files'
import { isRetryable, MAX_ATTEMPTS, retryDelayMs } from './retry'
import {
  isActive,
  isSettled,
  useUploadStore,
  type UploadConflict,
  type UploadItem,
  type UploadStatus,
} from './upload-store'
import { httpTransport, type UploadTransport } from './upload-transport'

// Runs uploads as described in DESIGN.md §6.1 and §10.2:
//
// - Sessions are created a little ahead of time, 64 per `POST /uploads/batch`,
//   so a small file costs one more request: its single PUT, which completes it.
// - A file larger than one part streams in a single request, read from disk
//   as it goes, one such file at a time. Its parts' hashes are worked out
//   alongside, one part in memory, and checked when it completes.
// - Up to 8 requests are in flight: small files fill the slots the stream
//   leaves, read and hashed a little ahead within a 100 MiB budget.
// - Progress counts bytes as the browser sends them, so it moves steadily.
// - A failed request is retried with exponential backoff, honouring
//   `Retry-After` (503 when the server's staging area is full). A broken or
//   paused stream starts again after the last part the server has. An upload
//   that fails all the same gives up its session at once; Retry starts it
//   afresh. One paused for 5 hours is canceled (`PAUSE_LIMIT_MS`).
// - Uploads live in their page, as on any website: closing or reloading it
//   cancels them, and the server forgets what had arrived (`cancelOnLeave`).
//   While it holds any, the page says every minute that it is still open;
//   the server gives up uploads whose page went quiet without cancelling.
//
// The engine keeps the authoritative state here and publishes it to the
// upload store about ten times a second, so a big batch doesn't re-render
// the panel for every progress event.

export interface UploadLimits {
  /** Requests in flight at once, across all files. */
  requests: number
  /** Files larger than one part streaming at once. */
  streams: number
  /** Sessions per `POST /uploads/batch` (the API allows up to 500). */
  sessionBatch: number
  /** The next batch of sessions is created when fewer than this many are ready. */
  sessionLowWater: number
  /** Extra small files to read and hash ahead of the requests in flight. */
  preparedParts: number
  /** Small files' bytes held by preparation and requests; one larger file may run alone. */
  bufferedBytes: number
}

export const DEFAULT_LIMITS: UploadLimits = {
  requests: 8,
  streams: 1,
  sessionBatch: 64,
  sessionLowWater: 32,
  preparedParts: 2,
  bufferedBytes: 100 * 1024 * 1024,
}

const PUBLISH_MS = 100
/** How often a page says its uploads are still open; ten quiet minutes give them up (§6.1). */
const ALIVE_EVERY_MS = 60_000
/** A paused upload is cancelled after this long, so it doesn't hold the server's space for days. */
export const PAUSE_LIMIT_MS = 5 * 60 * 60_000
/** Sessions per `POST /uploads/alive`, the API's limit. */
const ALIVE_BATCH = 500
const REFRESH_MS = 1000
const SPEED_WINDOW_MS = 5000
/** The shortest time a speed is worked out over, so the first bytes don't read as a burst. */
const SPEED_MIN_SPAN_MS = 250
const ENSURE_BATCH = 500
/** Nodes per `POST /nodes/lookup`, the API's limit. */
const LOOKUP_BATCH = 500

/** What to do with an upload whose name a file in its folder already has (D20). */
export type ConflictChoice =
  | { action: 'replace' }
  | { action: 'skip' }
  /** Under `name`, or, left out, under the next numbered name: `name (2).txt`. */
  | { action: 'keep'; name?: string }

/** One drop of files: a choice made "for all" answers its later conflicts too. */
interface Drop {
  choice: ConflictChoice | null
}

interface Job {
  id: string
  file: File
  parentId: string
  /** The name it is uploaded under: the file's own, or a copy's (`keep`). */
  name: string
  /** Whether a file with its name may become its new version (`replace`), or is asked about first. */
  ifExists: 'ask' | 'replace'
  drop: Drop
  /** While `conflict`: the file its name matched. */
  conflict: UploadConflict | null
  /** The number in the name of a copy named automatically, so a taken one counts on. */
  copyNumber: number | null
  status: UploadStatus
  session: UploadSession | null
  /** Parts the server has, as far as the engine knows. */
  doneParts: Set<number>
  /** What is in flight for the file: a small file's read and PUT, or its stream. */
  controller: AbortController | null
  /** A stream ended early: ask the server which parts it kept before sending more. */
  recheck: boolean
  /** A streamed file's part hashes, for completing it, worked out while it streams. */
  hashes: string[]
  hashing: { controller: AbortController; done: Promise<string[]> } | null
  uploadedBytes: number
  /** Failed tries in a row, for the backoff. */
  attempts: number
  retryTimer: ReturnType<typeof setTimeout> | null
  completing: boolean
  /** While paused: when the pause runs out and the upload is cancelled. */
  pausedUntil: number | null
  pauseTimer: ReturnType<typeof setTimeout> | null
  /** After the upload: where the file is on its way to Discord. */
  syncState: SyncState | null
  /** Node events can precede completion, but may describe an older version. */
  syncNeedsRefresh: boolean
  error: string | null
}

/** A small file read and hashed, ready for its PUT. */
interface PreparedFile {
  job: Job
  session: UploadSession
  controller: AbortController
  /** Bytes it holds of the budget. */
  size: number
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
  /** Jobs sending. */
  private active: Job[] = []
  private requests = 0
  private preparing = 0
  private bufferedBytes = 0
  private readonly ready: PreparedFile[] = []
  private creatingSessions = false
  private readonly preparingSessions = new Set<Job>()
  private syncRefresh: Promise<void> | null = null
  private aliveTimer: ReturnType<typeof setInterval> | null = null

  private readonly changes = new Map<string, Partial<UploadItem>>()
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private speedTimer: ReturnType<typeof setTimeout> | undefined
  private readonly foldersToRefresh = new Set<string>()
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private samples: { at: number; bytes: number }[] = []
  /** When sending last started after a pause in it, for the speed. */
  private sendingSince = 0

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
    const drop: Drop = { choice: null }
    for (const { file, relativeDir } of files) {
      const job: Job = {
        id: crypto.randomUUID(),
        file,
        parentId: folderIds.get(relativeDir) ?? parentId,
        name: file.name,
        ifExists: 'ask',
        drop,
        conflict: null,
        copyNumber: null,
        status: 'queued',
        session: null,
        doneParts: new Set(),
        controller: null,
        recheck: false,
        hashes: [],
        hashing: null,
        uploadedBytes: 0,
        attempts: 0,
        retryTimer: null,
        completing: false,
        pausedUntil: null,
        pauseTimer: null,
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

  /** Starts a failed upload again, from its beginning: failing gave up its session. */
  retry(id: string): void {
    const job = this.jobs.get(id)
    if (job?.status !== 'failed') return
    job.status = 'queued'
    job.error = null
    job.attempts = 0
    this.requeue(job)
    this.publish(job)
    this.pump()
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.cancelJobs([job])
  }

  /**
   * Answers an upload whose name a file in its folder has: replace that file
   * with it (a new version), keep both, or skip it. `forAll` answers the
   * others waiting too, and those of the same drops still to come; kept
   * that way, they are named by number.
   */
  resolveConflict(id: string, choice: ConflictChoice, forAll = false): void {
    const job = this.jobs.get(id)
    if (job?.status !== 'conflict') return
    const others = forAll
      ? [...this.jobs.values()].filter((other) => other !== job && other.status === 'conflict')
      : []
    this.decide(job, choice)
    if (forAll) {
      const automatic: ConflictChoice = choice.action === 'keep' ? { action: 'keep' } : choice
      for (const other of others) other.drop.choice = automatic
      job.drop.choice = automatic
      for (const other of others) this.decide(other, automatic)
    }
    this.pump()
  }

  cancelAll(): void {
    this.cancelJobs([...this.jobs.values()])
  }

  /**
   * Drops finished, failed and canceled uploads from the list. Files still
   * on their way to Discord stay.
   */
  clearFinished(): void {
    const removed = new Set<string>()
    for (const job of this.jobs.values()) {
      if (isActive(job.status) || job.status === 'paused' || job.status === 'conflict') continue
      if (job.status === 'done' && !isSettled(job.syncState)) continue
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

  /**
   * The page is going: its uploads go with it. Each session not completed is
   * cancelled on the server, in requests that outlive the page, so no half
   * file is left in its folder. A page that crashes says nothing more, and
   * the server gives its uploads up ten minutes later (`keepAlive`).
   */
  cancelOnLeave(): void {
    for (const uploadId of this.heldSessions()) {
      void this.transport.cancel(uploadId, { keepalive: true }).catch(ignore)
    }
  }

  /** Sessions this page holds that the server would keep: every upload not complete or cancelled. */
  private heldSessions(): string[] {
    const ids: string[] = []
    for (const job of this.jobs.values()) {
      if (!job.session || job.status === 'done' || job.status === 'canceled') continue
      ids.push(job.session.uploadId)
    }
    return ids
  }

  /** Says the page is open every minute, from its first session until it holds none. */
  private keepAlive(): void {
    this.aliveTimer ??= setInterval(() => void this.sayAlive(), ALIVE_EVERY_MS)
  }

  private async sayAlive(): Promise<void> {
    const ids = this.heldSessions()
    if (ids.length === 0) {
      if (this.aliveTimer) clearInterval(this.aliveTimer)
      this.aliveTimer = null
      return
    }
    // Missing one is harmless: the server waits ten minutes.
    for (let start = 0; start < ids.length; start += ALIVE_BATCH) {
      await this.transport.alive(ids.slice(start, start + ALIVE_BATCH)).catch(ignore)
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
    // Streams first: small files read ahead take whatever slots are left.
    for (const job of this.active) this.feed(job)
    this.sendReady()

    // Start waiting files while there is room: a larger file when a stream
    // is free, a small one when it can be read ahead.
    let streams = this.active.filter(isLarge).length
    for (let index = 0; index < this.waiting.length;) {
      const job = this.waiting[index]
      if (!job?.session) break
      if (isLarge(job)) {
        if (streams >= this.limits.streams) {
          index += 1
          continue
        }
        streams += 1
      } else if (!this.canPrepare(partSize(job, job.session, 0))) {
        break
      }
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
    this.feed(job)
  }

  /** Starts what a file needs next: its stream, its small file's read, or its completion. */
  private feed(job: Job): void {
    const { session } = job
    if (job.status !== 'uploading' || !session) return
    if (job.retryTimer || job.completing || job.controller) return
    if (allPartsDone(job)) void this.finish(job)
    else if (isLarge(job)) {
      if (this.requests < this.limits.requests) this.stream(job, session)
    } else if (this.canPrepare(partSize(job, session, 0))) {
      this.prepare(job, session)
    }
  }

  // ── Small files: read, hash, one PUT ─────────────────────────────────────

  private prepare(job: Job, session: UploadSession): void {
    const controller = new AbortController()
    const size = partSize(job, session, 0)
    job.controller = controller
    this.bufferedBytes += size
    this.preparing += 1
    void this.read(job, session, controller, size).finally(() => {
      this.preparing -= 1
      this.pump()
    })
  }

  private async read(
    job: Job,
    session: UploadSession,
    controller: AbortController,
    size: number,
  ): Promise<void> {
    let prepared = false
    try {
      const bytes = await job.file.slice(0, session.chunkSize).arrayBuffer()
      if (!this.canSend(job, session, controller)) return
      const hash = await sha256Hex(bytes)
      if (!this.canSend(job, session, controller)) return
      this.ready.push({ job, session, controller, size, bytes, hash })
      prepared = true
    } catch (error) {
      if (!controller.signal.aborted) this.handleFailure(job, error)
    } finally {
      if (!prepared) this.release(job, controller, size)
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

  private sendReady(): void {
    while (this.ready.length > 0 && this.requests < this.limits.requests) {
      const prepared = this.ready.shift()
      if (!prepared) break
      const { job, session, controller, size } = prepared
      if (!this.canSend(job, session, controller)) {
        controller.abort()
        this.release(job, controller, size)
        continue
      }
      this.requests += 1
      void this.put(prepared).finally(() => {
        this.requests -= 1
        this.release(job, controller, size)
        this.pump()
      })
    }
  }

  private release(job: Job, controller: AbortController, size: number): void {
    this.bufferedBytes -= size
    if (job.controller === controller) job.controller = null
  }

  private async put({ job, session, controller, bytes, hash }: PreparedFile): Promise<void> {
    const progress = this.progress(job, controller, 0)
    try {
      await this.transport.putPart(session.uploadId, 0, bytes, hash, controller.signal, progress)
      if (job.session !== session) return
      // Whatever the progress events didn't report counts now.
      progress(bytes.byteLength)
      job.doneParts.add(0)
      job.uploadedBytes = job.file.size
      job.attempts = 0
      this.publish(job)
    } catch (error) {
      if (controller.signal.aborted) return
      job.uploadedBytes = 0
      this.handleFailure(job, error)
    }
  }

  // ── Larger files: one stream ─────────────────────────────────────────────

  private stream(job: Job, session: UploadSession): void {
    const controller = new AbortController()
    job.controller = controller
    this.requests += 1
    void this.send(job, session, controller).finally(() => {
      this.requests -= 1
      if (job.controller === controller) job.controller = null
      this.pump()
    })
  }

  /** Streams the file from its first part the server lacks to its end. */
  private async send(job: Job, session: UploadSession, controller: AbortController) {
    try {
      if (job.recheck) {
        const status = await this.transport.status(session.uploadId)
        if (!this.canSend(job, session, controller)) return
        // A stream that stored more than the last one starts its tries afresh.
        if (status.receivedParts.length > job.doneParts.size) job.attempts = 0
        received(job, session, status.receivedParts)
        this.publish(job)
      }
      const from = firstMissing(job, session)
      if (from === session.chunkCount) return
      // The hashes for completing it, read alongside; completing waits for them.
      void this.partHashes(job, session).catch(() => undefined)
      const base = from * session.chunkSize
      const progress = this.progress(job, controller, base)
      await this.transport.streamFile(
        session.uploadId,
        from,
        job.file.slice(base),
        controller.signal,
        progress,
      )
      if (job.session !== session) return
      progress(job.file.size - base)
      for (let index = from; index < session.chunkCount; index += 1) job.doneParts.add(index)
      job.uploadedBytes = job.file.size
      job.attempts = 0
      this.publish(job)
    } catch (error) {
      // The server keeps the parts that arrived whole; which those are, it says.
      job.recheck = true
      if (!controller.signal.aborted) this.handleFailure(job, error)
    }
  }

  /**
   * Every part's SHA-256, for completing a streamed file: one part read at a
   * time, while it streams. A pass stopped by a pause carries on from there.
   */
  private partHashes(job: Job, session: UploadSession): Promise<string[]> {
    if (job.hashing) return job.hashing.done
    const controller = new AbortController()
    const hashes = job.hashes
    const done = (async () => {
      for (let index = 0; index < session.chunkCount; index += 1) {
        if (hashes[index] !== undefined) continue
        const start = index * session.chunkSize
        const bytes = await job.file.slice(start, start + session.chunkSize).arrayBuffer()
        controller.signal.throwIfAborted()
        hashes[index] = await sha256Hex(bytes)
      }
      return hashes
    })()
    const hashing = { controller, done }
    job.hashing = hashing
    done.catch(() => {
      if (job.hashing === hashing) job.hashing = null
    })
    return done
  }

  // ── Both ─────────────────────────────────────────────────────────────────

  /** Counts a request's body as it goes out: the file's progress, and the speed. */
  private progress(job: Job, controller: AbortController, base: number): (sent: number) => void {
    // After a pause in sending, the speed counts from now, not from the last bytes.
    if (this.samples.length === 0) this.sendingSince = Date.now()
    let counted = 0
    return (sent) => {
      if (controller.signal.aborted || sent <= counted) return
      this.recordSpeed(sent - counted)
      counted = sent
      job.uploadedBytes = Math.min(job.file.size, base + sent)
      this.publish(job)
    }
  }

  private handleFailure(job: Job, error: unknown): void {
    if (job.status !== 'uploading') return
    // Sessions answer until they expire, also once complete, and a part sent
    // again is accepted (§6.1), so a lost response is simply retried. A 404
    // means the session expired.
    if (isNotFound(error)) {
      resetSession(job)
      this.fail(job, 'The upload expired. Retry to start it again.')
      return
    }
    const attempts = job.attempts + 1
    if (isRetryable(error) && attempts <= MAX_ATTEMPTS) {
      job.attempts = attempts
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
      // Others complete with their parts' hashes, which the server checks.
      if (session.chunkCount !== 1) {
        const hashes = await this.partHashes(job, session)
        if (job.session !== session || job.status !== 'uploading') return
        await this.withRetries(
          () => this.transport.complete(session.uploadId, hashes),
          (error) => isRetryable(error) && !isCorrupted(error),
        )
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
      if (job.status !== 'uploading' || job.session !== session) return
      if (isCorrupted(error)) {
        // The server dropped the parts that arrived damaged: which those are,
        // it says before they go again.
        job.doneParts = new Set()
        job.recheck = true
        this.handleFailure(job, error)
      } else {
        this.fail(job, errorMessage(error))
      }
    } finally {
      job.completing = false
      this.pump()
    }
  }

  /**
   * Ends an upload that won't finish: its session goes from the server now,
   * with its half file, so nothing waits in its folder or holds the server's
   * space. Retry starts it afresh.
   */
  private fail(job: Job, message: string): void {
    this.stop(job)
    this.dropSession(job)
    resetSession(job)
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
            name: job.name,
            sizeBytes: job.file.size,
            mimeType: job.file.type || 'application/octet-stream',
            ifExists: job.ifExists,
            ...ownModifiedAt(job.file),
          })),
        ),
      )
      batch.forEach((job, index) => {
        const result = results[index]
        if (!result?.ok) {
          if (job.status !== 'queued') return
          if (result?.existing) this.nameTaken(job, result.existing)
          else this.fail(job, result?.error.message ?? 'Could not start.')
          return
        }
        job.session = result.session
        if (job.status === 'canceled') this.dropSession(job)
        else if (job.status === 'queued') this.waiting.push(job)
        // A job paused meanwhile keeps its session for when it resumes.
      })
      this.keepAlive()
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

  /** Its name is a file's: answered by its drop's choice for all, or it waits for one. */
  private nameTaken(job: Job, existing: ExistingFile): void {
    // Its batch is answered: it may go back in line before the batch is done.
    this.preparingSessions.delete(job)
    if (job.drop.choice) {
      this.decide(job, job.drop.choice, existing)
      return
    }
    const { base, extension } = splitExtension(job.file.name)
    job.status = 'conflict'
    job.conflict = {
      versions: existing.versions,
      links: existing.links,
      suggestedName: `${base} (${String(Math.max(1, existing.versions))})${extension}`,
    }
    this.publish(job)
  }

  /** Acts on a choice: back in line to replace or under a copy's name, or skipped. */
  private decide(job: Job, choice: ConflictChoice, existing?: ExistingFile): void {
    const versions = existing?.versions ?? job.conflict?.versions ?? 0
    job.conflict = null
    if (choice.action === 'skip') {
      this.cancelJobs([job])
      job.error = `Skipped: “${job.name}” already exists`
      this.publish(job)
      return
    }
    if (choice.action === 'replace') {
      job.ifExists = 'replace'
    } else if (choice.name !== undefined) {
      job.name = choice.name
      job.copyNumber = null
    } else {
      // Numbered from the file's versions, or on from a copy's name also taken.
      const number = job.copyNumber === null ? Math.max(1, versions) : job.copyNumber + 1
      const { base, extension } = splitExtension(job.file.name)
      job.copyNumber = number
      job.name = `${base} (${String(number)})${extension}`
    }
    job.status = 'queued'
    this.requeue(job)
    this.publish(job)
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
      this.abortRequests(job)
      this.clearRetry(job)
      job.status = 'paused'
      job.pausedUntil = Date.now() + PAUSE_LIMIT_MS
      job.pauseTimer = setTimeout(() => {
        this.pauseRanOut(job)
      }, PAUSE_LIMIT_MS)
      paused.add(job)
      this.publish(job)
    }
    this.removeFromQueues(paused)
    this.pump()
  }

  /** A pause that lasted `PAUSE_LIMIT_MS` cancels its upload, and says why. */
  private pauseRanOut(job: Job): void {
    job.pauseTimer = null
    if (job.status !== 'paused') return
    this.cancelJobs([job])
    job.error = 'Canceled after 5 hours paused'
    this.publish(job)
  }

  private clearPause(job: Job): void {
    if (job.pauseTimer !== null) clearTimeout(job.pauseTimer)
    job.pauseTimer = null
    job.pausedUntil = null
  }

  private resumeJobs(jobs: (Job | undefined)[]): void {
    // In reverse, so requeuing each at the front keeps their order.
    for (const job of jobs.toReversed()) {
      if (job?.status !== 'paused') continue
      this.clearPause(job)
      job.status = 'queued'
      job.attempts = 0
      this.requeue(job)
      this.publish(job)
    }
    this.pump()
  }

  private cancelJobs(jobs: Job[]): void {
    const canceled = new Set<Job>()
    for (const job of jobs) {
      if (job.status === 'done' || job.status === 'canceled') continue
      this.abortRequests(job)
      this.clearRetry(job)
      this.clearPause(job)
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
    if (this.preparingSessions.has(job)) return
    if (job.session) this.waiting.unshift(job)
    else this.needSession.unshift(job)
  }

  private stop(job: Job): void {
    this.abortRequests(job)
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

  /** Stops a file's request, read or stream, and the hashing alongside a stream. */
  private abortRequests(job: Job): void {
    job.controller?.abort()
    job.hashing?.controller.abort()
    job.hashing = null
  }

  private clearRetry(job: Job): void {
    if (job.retryTimer === null) return
    clearTimeout(job.retryTimer)
    job.retryTimer = null
  }

  private async withRetries<T>(
    work: () => Promise<T>,
    retryable: (error: unknown) => boolean = isRetryable,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work()
      } catch (error) {
        if (!retryable(error) || attempt > MAX_ATTEMPTS) throw error
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
    // Keep the speed current while sending, even when no bytes go for a
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

  /** Bytes per second over the last few seconds, or since sending started if that is sooner. */
  private speed(): number {
    const now = Date.now()
    this.samples = this.samples.filter((sample) => now - sample.at < SPEED_WINDOW_MS)
    if (this.samples.length === 0) return 0
    const bytes = this.samples.reduce((total, sample) => total + sample.bytes, 0)
    const since = Math.max(now - SPEED_WINDOW_MS, this.sendingSince)
    return (bytes * 1000) / Math.max(SPEED_MIN_SPAN_MS, now - since)
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
    name: job.name,
    status: job.status,
    conflict: job.conflict,
    uploadedBytes: job.uploadedBytes,
    nodeId: job.session?.nodeId ?? null,
    syncState: job.syncState,
    retrying: job.retryTimer !== null,
    pausedUntil: job.pausedUntil,
    error: job.error,
  }
}

/** Larger than one part: streamed. */
function isLarge(job: Job): boolean {
  return (job.session?.chunkCount ?? 0) > 1
}

function allPartsDone(job: Job): boolean {
  return job.session !== null && job.doneParts.size >= job.session.chunkCount
}

/** Where a stream starts: the first part the server doesn't have. */
function firstMissing(job: Job, session: UploadSession): number {
  let index = 0
  while (index < session.chunkCount && job.doneParts.has(index)) index += 1
  return index
}

/** What the server says it has (`GET /uploads/:id`). */
function received(job: Job, session: UploadSession, parts: readonly number[]): void {
  job.doneParts = new Set(parts)
  job.recheck = false
  job.uploadedBytes = parts.reduce((total, index) => total + partSize(job, session, index), 0)
}

/**
 * A file's own modification date, which the drive shows as its "Modified"
 * (§6.1). Left out when the browser doesn't know it: some pickers say 0.
 */
function ownModifiedAt(file: File): { modifiedAt?: string } {
  const date = new Date(file.lastModified)
  const known = file.lastModified > 0 && date.getUTCFullYear() <= 9999
  return known ? { modifiedAt: date.toISOString() } : {}
}

function resetSession(job: Job): void {
  job.session = null
  job.doneParts = new Set()
  job.recheck = false
  job.hashing?.controller.abort()
  job.hashing = null
  job.hashes = []
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

/** Parts arrived damaged, and the server dropped them (§6.1). */
function isCorrupted(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'hash_mismatch'
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
  window.addEventListener('pagehide', () => {
    uploadEngine.cancelOnLeave()
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
