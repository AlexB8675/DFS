import type { ServiceStatus, SystemAlert } from '@dfs/shared'

// What needs an admin's attention now (DESIGN.md §16), from the health
// figures and the last hour of metrics. Shown at the top of the overview,
// worst first; each says what is wrong and what it means for users.

/** When a figure becomes worth an alert. */
const LIMITS = {
  stagingWarning: 0.8,
  stagingCritical: 0.95,
  /** A blob this long in the queue means syncing has stalled or fallen far behind. */
  pendingSeconds: 15 * 60,
  /** Released blobs whose deletion failed this many times. */
  deleteAttempts: 3,
  /** In the last hour. */
  rateLimited: 20,
  serverErrors: 5,
  cdnFailures: 10,
  /** The CDN asked the API to slow down. Reads wait and go on, but it may be near a block. */
  cdnSlowDowns: 5,
  postFailures: 5,
  deadlocks: 1,
  /** The media service failing asks while it answers its health checks. */
  mediaFailures: 5,
  /** File reads that broke off while sending, as the API saw them. */
  downloadFailures: 3,
  /** Plays stopped by a failed read, as their players reported them. */
  playReadFailures: 3,
  /** The slowest 5% of file reads this slow to their first byte, of at least this many. */
  slowFirstByteMs: 5000,
  slowFirstByteReads: 20,
  /** Shares of `max_connections` in use. */
  connectionsWarning: 0.8,
  connectionsCritical: 0.95,
  /** An open transaction this old holds back vacuum and may block others. */
  transactionSeconds: 10 * 60,
  /** Changes this long out of #dfs-journal: the API seals a batch a minute, the bot posts it at once. */
  journalSeconds: 10 * 60,
}

export interface AlertFigures {
  bot: { status: ServiceStatus; detail: string }
  /** The media service's answer to the API's health check (§6.7); `degraded` when there is none. */
  media: ServiceStatus
  failedJobs: number
  oldestPendingSeconds: number
  stagedBytes: number
  stagingMaxBytes: number
  /** Released blobs that failed to delete `LIMITS.deleteAttempts` times or more. */
  failingDeletions: number
  /** Accounts someone asked a new password for on the sign-in page (§7.1). */
  passwordResets: number
  database: {
    connections: number
    maxConnections: number
    oldestTransactionSeconds: number
    /** Queries that have waited 30 s or more for a lock. */
    longLockWaits: number
  }
  lastHour: {
    rateLimited: number
    serverErrors: number
    cdnFailures: number
    cdnSlowDowns: number
    postFailures: number
    deadlocks: number
    mediaFailures: number
    downloadFailures: number
    playReadFailures: number
    /** File reads timed to their first byte, and the 95th percentile of those times. */
    firstBytes: { reads: number; p95Ms: number | null }
  }
  /**
   * The API's checks (§16): down once its last three got no answer. Discord
   * is never down with a local blob store, which doesn't need it.
   */
  network: { discordDown: boolean; internetDown: boolean }
  /**
   * How far the journal is behind (§8): the oldest change not in #dfs-journal
   * yet, sealed or not, and why the batch first in line failed, if it did.
   */
  journal: { behindSeconds: number; lastError: string | null }
}

export const FAILING_DELETE_ATTEMPTS = LIMITS.deleteAttempts

export function healthAlerts(figures: AlertFigures): SystemAlert[] {
  const alerts: SystemAlert[] = []
  const { bot, lastHour, database, network } = figures

  // Discord and the internet both silent is the server's network: one alert.
  if (network.discordDown) {
    alerts.push(
      network.internetDown
        ? {
            code: 'offline',
            level: 'critical',
            title: 'The server can’t reach the internet',
            detail:
              'Neither Discord nor the internet answers the API’s checks: nothing reaches Discord, and files that aren’t cached can’t be read.',
          }
        : {
            code: 'discord_unreachable',
            level: 'critical',
            title: 'Discord isn’t answering',
            detail:
              'The API’s checks get no answer: nothing reaches Discord, and files that aren’t cached can’t be read, until it does.',
          },
    )
  }
  if (bot.status === 'down') {
    alerts.push({
      code: 'bot_down',
      level: 'critical',
      title: 'The bot isn’t answering',
      detail:
        'Nothing reaches Discord until it is back, and files that aren’t cached can’t be read.',
    })
  } else if (bot.status === 'degraded') {
    alerts.push({
      code: 'bot_degraded',
      level: 'warning',
      title: 'The bot isn’t storing anything',
      detail: `It answers, but reports ${bot.detail}.`,
    })
  }
  // None set up is a choice, not an alert.
  if (figures.media === 'down') {
    alerts.push({
      code: 'media_down',
      level: 'warning',
      title: 'The media service isn’t answering',
      detail:
        'Videos play as they are until it is back: a file not examined yet shows no formats or chapters, and subtitles inside it can’t be read.',
    })
  } else if (lastHour.mediaFailures >= LIMITS.mediaFailures) {
    alerts.push({
      code: 'media_failing',
      level: 'warning',
      title: 'The media service is failing',
      detail: `${plural(lastHour.mediaFailures, 'request')} to it failed in the last hour: files weren’t examined, or subtitles or covers inside them couldn’t be read.`,
    })
  }
  const staging = figures.stagingMaxBytes > 0 ? figures.stagedBytes / figures.stagingMaxBytes : 0
  if (staging >= LIMITS.stagingWarning) {
    alerts.push({
      code: 'staging_full',
      level: staging >= LIMITS.stagingCritical ? 'critical' : 'warning',
      title: `Staging is ${String(Math.floor(staging * 100))}% full`,
      detail: 'Uploads are refused once it is full, until the bot has stored what waits.',
    })
  }
  const connections =
    database.maxConnections > 0 ? database.connections / database.maxConnections : 0
  if (connections >= LIMITS.connectionsWarning) {
    alerts.push({
      code: 'db_connections',
      level: connections >= LIMITS.connectionsCritical ? 'critical' : 'warning',
      title: 'Database connections are running out',
      detail: `${String(database.connections)} of ${String(database.maxConnections)} are in use; past the limit, requests fail.`,
    })
  }
  if (figures.failedJobs > 0) {
    alerts.push({
      code: 'uploads_failed',
      level: 'warning',
      title: 'Storing in Discord gave up',
      detail: `${plural(figures.failedJobs, 'blob')} failed every try and won’t be retried on their own.`,
    })
  }
  if (figures.oldestPendingSeconds >= LIMITS.pendingSeconds) {
    alerts.push({
      code: 'sync_slow',
      level: 'warning',
      title: 'Syncing is behind',
      detail: `The oldest blob has waited ${minutes(figures.oldestPendingSeconds)} to be stored in Discord.`,
    })
  }
  if (figures.failingDeletions > 0) {
    alerts.push({
      code: 'deletions_failing',
      level: 'warning',
      title: 'Deleting from Discord keeps failing',
      detail: `${plural(figures.failingDeletions, 'released blob')} failed to delete ${String(LIMITS.deleteAttempts)} times or more.`,
    })
  }
  if (figures.journal.behindSeconds >= LIMITS.journalSeconds) {
    alerts.push({
      code: 'journal_behind',
      level: 'warning',
      title: 'Changes aren’t reaching #dfs-journal',
      detail: `The journal is ${minutes(figures.journal.behindSeconds)} behind: if this server were lost now, recovery from Discord would miss those changes.${figures.journal.lastError ? ` Last error: ${figures.journal.lastError}` : ''}`,
    })
  }
  if (database.oldestTransactionSeconds >= LIMITS.transactionSeconds) {
    alerts.push({
      code: 'db_long_transaction',
      level: 'warning',
      title: 'A database transaction has been open for long',
      detail: `It has run ${minutes(database.oldestTransactionSeconds)}, holding back vacuum; Admin → Database can end its connection.`,
    })
  }
  if (database.longLockWaits > 0) {
    alerts.push({
      code: 'db_lock_waits',
      level: 'warning',
      title: 'Queries are stuck waiting for locks',
      detail: `${plural(database.longLockWaits, 'query')} waited 30 s or more; Admin → Database shows what blocks them.`,
    })
  }
  if (lastHour.deadlocks >= LIMITS.deadlocks) {
    alerts.push({
      code: 'db_deadlocks',
      level: 'warning',
      title: 'The database broke deadlocks',
      detail: `${plural(lastHour.deadlocks, 'deadlock')} in the last hour: each failed one transaction.`,
    })
  }
  if (lastHour.postFailures >= LIMITS.postFailures) {
    alerts.push({
      code: 'posts_failing',
      level: 'warning',
      title: 'Posting to Discord is failing',
      detail: `${plural(lastHour.postFailures, 'attempt')} failed in the last hour; they are retried.`,
    })
  }
  if (lastHour.rateLimited >= LIMITS.rateLimited) {
    alerts.push({
      code: 'rate_limited',
      level: 'warning',
      title: 'Discord is rate-limiting the bot',
      detail: `${plural(lastHour.rateLimited, 'request')} answered 429 in the last hour.`,
    })
  }
  if (lastHour.cdnFailures >= LIMITS.cdnFailures) {
    alerts.push({
      code: 'cdn_failing',
      level: 'warning',
      title: 'Reading from Discord is failing',
      detail: `${plural(lastHour.cdnFailures, 'read')} from the CDN failed in the last hour.`,
    })
  }
  if (lastHour.downloadFailures >= LIMITS.downloadFailures) {
    alerts.push({
      code: 'downloads_failing',
      level: 'warning',
      title: 'Sending files is failing',
      detail: `${plural(lastHour.downloadFailures, 'file read')} broke off in the last hour, cutting downloads and plays short; the API’s log says why.`,
    })
  }
  // Reported by players, which anyone with a link can send: a warning at most.
  if (lastHour.playReadFailures >= LIMITS.playReadFailures) {
    alerts.push({
      code: 'plays_failing',
      level: 'warning',
      title: 'Videos stop on failed reads',
      detail: `${plural(lastHour.playReadFailures, 'play')} stopped in the last hour on a read that failed, as their players reported: the server, Discord, or the viewers’ connections.`,
    })
  }
  const { firstBytes } = lastHour
  if (
    firstBytes.reads >= LIMITS.slowFirstByteReads &&
    firstBytes.p95Ms !== null &&
    firstBytes.p95Ms >= LIMITS.slowFirstByteMs
  ) {
    alerts.push({
      code: 'downloads_slow',
      level: 'warning',
      title: 'Files are slow to start',
      detail: `In the last hour, 1 file read in 20 took ${seconds(firstBytes.p95Ms)} or more to its first byte. Monitoring → Reading back shows whether Discord is slow.`,
    })
  }
  if (lastHour.cdnSlowDowns >= LIMITS.cdnSlowDowns) {
    alerts.push({
      code: 'cdn_slowed',
      level: 'warning',
      title: 'Discord’s CDN asks DFS to slow down',
      detail: `${plural(lastHour.cdnSlowDowns, 'time')} in the last hour: reads waited, then went on.`,
    })
  }
  if (lastHour.serverErrors >= LIMITS.serverErrors) {
    alerts.push({
      code: 'server_errors',
      level: 'warning',
      title: 'The API is failing requests',
      detail: `${plural(lastHour.serverErrors, 'request')} ended in a server error in the last hour.`,
    })
  }
  // Critical first; otherwise in the order above, most telling first.
  if (figures.passwordResets > 0) {
    alerts.push({
      code: 'password_resets',
      level: 'warning',
      title:
        figures.passwordResets === 1
          ? 'Someone asked for a new password'
          : `${String(figures.passwordResets)} people asked for new passwords`,
      detail:
        'Admin → Users marks who. Make sure it was them, then give them a temporary password with Reset password.',
    })
  }
  return alerts.sort((a, b) => Number(b.level === 'critical') - Number(a.level === 'critical'))
}

function plural(count: number, noun: string): string {
  const many = noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`
  return `${count.toLocaleString('en')} ${count === 1 ? noun : many}`
}

function seconds(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toLocaleString('en')} s`
}

function minutes(seconds: number): string {
  const total = Math.round(seconds / 60)
  if (total < 60) return `${String(total)} min`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`
}
