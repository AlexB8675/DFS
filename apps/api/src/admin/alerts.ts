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
  postFailures: 5,
}

export interface AlertFigures {
  bot: { status: ServiceStatus; detail: string }
  lostBlobs: number
  lostFiles: number
  failedJobs: number
  oldestPendingSeconds: number
  stagedBytes: number
  stagingMaxBytes: number
  /** Released blobs that failed to delete `LIMITS.deleteAttempts` times or more. */
  failingDeletions: number
  lastHour: { rateLimited: number; serverErrors: number; cdnFailures: number; postFailures: number }
}

export const FAILING_DELETE_ATTEMPTS = LIMITS.deleteAttempts

export function healthAlerts(figures: AlertFigures): SystemAlert[] {
  const alerts: SystemAlert[] = []
  const { bot, lastHour } = figures

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
  if (figures.lostBlobs > 0) {
    alerts.push({
      code: 'lost_blobs',
      level: 'critical',
      title: plural(figures.lostBlobs, 'lost blob'),
      detail: `${plural(figures.lostFiles, 'file')} can’t be downloaded: their messages were deleted in Discord.`,
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
  if (lastHour.serverErrors >= LIMITS.serverErrors) {
    alerts.push({
      code: 'server_errors',
      level: 'warning',
      title: 'The API is failing requests',
      detail: `${plural(lastHour.serverErrors, 'request')} ended in a server error in the last hour.`,
    })
  }
  // Critical first; otherwise in the order above, most telling first.
  return alerts.sort((a, b) => Number(b.level === 'critical') - Number(a.level === 'critical'))
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en')} ${noun}${count === 1 ? '' : 's'}`
}

function minutes(seconds: number): string {
  const total = Math.round(seconds / 60)
  if (total < 60) return `${String(total)} min`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`
}
