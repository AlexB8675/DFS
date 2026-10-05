import { describe, expect, it } from 'vitest'
import { healthAlerts, type AlertFigures } from './alerts.ts'

const calm: AlertFigures = {
  bot: { status: 'ok', detail: 'leader, queue running' },
  lostBlobs: 0,
  lostFiles: 0,
  failedJobs: 0,
  oldestPendingSeconds: 30,
  stagedBytes: 10,
  stagingMaxBytes: 100,
  failingDeletions: 0,
  lastHour: { rateLimited: 3, serverErrors: 0, cdnFailures: 0, postFailures: 0 },
}

describe('health alerts (DESIGN.md §16)', () => {
  it('stays quiet while everything is fine', () => {
    expect(healthAlerts(calm)).toEqual([])
  })

  it('names what is wrong, critical first', () => {
    const alerts = healthAlerts({
      ...calm,
      bot: { status: 'down', detail: 'Not answering' },
      lostBlobs: 2,
      lostFiles: 1,
      failedJobs: 1,
      oldestPendingSeconds: 3700,
      stagedBytes: 85,
      failingDeletions: 4,
      lastHour: { rateLimited: 20, serverErrors: 5, cdnFailures: 10, postFailures: 5 },
    })
    expect(alerts.map((alert) => [alert.code, alert.level])).toEqual([
      ['bot_down', 'critical'],
      ['lost_blobs', 'critical'],
      ['staging_full', 'warning'],
      ['uploads_failed', 'warning'],
      ['sync_slow', 'warning'],
      ['deletions_failing', 'warning'],
      ['posts_failing', 'warning'],
      ['rate_limited', 'warning'],
      ['cdn_failing', 'warning'],
      ['server_errors', 'warning'],
    ])
    expect(alerts[1]).toMatchObject({
      title: '2 lost blobs',
      detail: '1 file can’t be downloaded: their messages were deleted in Discord.',
    })
    expect(alerts.find((alert) => alert.code === 'sync_slow')?.detail).toBe(
      'The oldest blob has waited 1 h 2 min to be stored in Discord.',
    )
  })

  it('makes a nearly full staging critical', () => {
    const [alert] = healthAlerts({ ...calm, stagedBytes: 96 })
    expect(alert).toMatchObject({
      code: 'staging_full',
      level: 'critical',
      title: 'Staging is 96% full',
    })
  })
})
