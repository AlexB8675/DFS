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
  database: { connections: 12, maxConnections: 100, oldestTransactionSeconds: 2, longLockWaits: 0 },
  lastHour: { rateLimited: 3, serverErrors: 0, cdnFailures: 0, postFailures: 0, deadlocks: 0 },
  network: { discordDown: false, internetDown: false },
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
      database: {
        connections: 85,
        maxConnections: 100,
        oldestTransactionSeconds: 900,
        longLockWaits: 1,
      },
      lastHour: {
        rateLimited: 20,
        serverErrors: 5,
        cdnFailures: 10,
        postFailures: 5,
        deadlocks: 2,
      },
    })
    expect(alerts.map((alert) => [alert.code, alert.level])).toEqual([
      ['bot_down', 'critical'],
      ['lost_blobs', 'critical'],
      ['staging_full', 'warning'],
      ['db_connections', 'warning'],
      ['uploads_failed', 'warning'],
      ['sync_slow', 'warning'],
      ['deletions_failing', 'warning'],
      ['db_long_transaction', 'warning'],
      ['db_lock_waits', 'warning'],
      ['db_deadlocks', 'warning'],
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
    expect(alerts.find((alert) => alert.code === 'db_lock_waits')?.detail).toBe(
      '1 query waited 30 s or more; Admin → Database shows what blocks them.',
    )
  })

  it('says when lost blobs held only older versions, which leaves every file readable', () => {
    const [alert] = healthAlerts({ ...calm, lostBlobs: 1, lostFiles: 0 })
    expect(alert).toMatchObject({ code: 'lost_blobs', level: 'critical', title: '1 lost blob' })
    expect(alert?.detail).toMatch(/only older versions: every file can still be downloaded/)
  })

  it('makes almost no database connections left critical', () => {
    const [alert] = healthAlerts({
      ...calm,
      database: { ...calm.database, connections: 96 },
    })
    expect(alert).toMatchObject({ code: 'db_connections', level: 'critical' })
  })

  it('says when Discord doesn’t answer, and when the whole server is cut off, once', () => {
    const raised = (discordDown: boolean, internetDown: boolean) =>
      healthAlerts({ ...calm, network: { discordDown, internetDown } }).map((alert) => [
        alert.code,
        alert.level,
      ])
    expect(raised(true, false)).toEqual([['discord_unreachable', 'critical']])
    expect(raised(true, true)).toEqual([['offline', 'critical']])
    // DFS works on while only the internet check fails: the overview's dot says so.
    expect(raised(false, true)).toEqual([])
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
