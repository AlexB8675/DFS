import { describe, expect, it } from 'vitest'
import { healthAlerts, type AlertFigures } from './alerts.ts'

const calm: AlertFigures = {
  bot: { status: 'ok', detail: 'leader, queue running' },
  media: 'ok',
  failedJobs: 0,
  oldestPendingSeconds: 30,
  stagedBytes: 10,
  stagingMaxBytes: 100,
  failingDeletions: 0,
  passwordResets: 0,
  database: { connections: 12, maxConnections: 100, oldestTransactionSeconds: 2, longLockWaits: 0 },
  lastHour: {
    rateLimited: 3,
    serverErrors: 0,
    cdnFailures: 0,
    cdnSlowDowns: 0,
    postFailures: 0,
    deadlocks: 0,
    mediaFailures: 1,
    downloadFailures: 0,
    playReadFailures: 1,
    firstBytes: { reads: 400, p95Ms: 900 },
  },
  network: { discordDown: false, internetDown: false },
  journal: { behindSeconds: 45, lastError: null },
}

describe('health alerts (DESIGN.md §16)', () => {
  it('stays quiet while everything is fine', () => {
    expect(healthAlerts(calm)).toEqual([])
  })

  it('says when changes haven’t reached #dfs-journal for ten minutes, and why', () => {
    expect(healthAlerts({ ...calm, journal: { behindSeconds: 590, lastError: null } })).toEqual([])
    const [alert] = healthAlerts({
      ...calm,
      journal: { behindSeconds: 1500, lastError: 'Discord is down' },
    })
    expect(alert).toMatchObject({ code: 'journal_behind', level: 'warning' })
    expect(alert?.detail).toContain('25 min behind')
    expect(alert?.detail).toContain('Last error: Discord is down')
  })

  it('names what is wrong, critical first', () => {
    const alerts = healthAlerts({
      ...calm,
      bot: { status: 'down', detail: 'Not answering' },
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
        cdnSlowDowns: 5,
        postFailures: 5,
        deadlocks: 2,
        mediaFailures: 5,
        downloadFailures: 3,
        playReadFailures: 3,
        firstBytes: { reads: 20, p95Ms: 5000 },
      },
    })
    expect(alerts.map((alert) => [alert.code, alert.level])).toEqual([
      ['bot_down', 'critical'],
      ['media_failing', 'warning'],
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
      ['downloads_failing', 'warning'],
      ['plays_failing', 'warning'],
      ['downloads_slow', 'warning'],
      ['cdn_slowed', 'warning'],
      ['server_errors', 'warning'],
    ])
    expect(alerts.find((alert) => alert.code === 'sync_slow')?.detail).toBe(
      'The oldest blob has waited 1 h 2 min to be stored in Discord.',
    )
    expect(alerts.find((alert) => alert.code === 'db_lock_waits')?.detail).toBe(
      '1 query waited 30 s or more; Admin → Database shows what blocks them.',
    )
  })

  it('says when someone asked for a new password, for the admins to give one', () => {
    expect(healthAlerts({ ...calm, passwordResets: 1 })).toEqual([
      expect.objectContaining({
        code: 'password_resets',
        level: 'warning',
        title: 'Someone asked for a new password',
      }),
    ])
    expect(healthAlerts({ ...calm, passwordResets: 3 })[0]?.title).toBe(
      '3 people asked for new passwords',
    )
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

  it('says when the media service doesn’t answer, and not when there is none', () => {
    expect(healthAlerts({ ...calm, media: 'down' })).toEqual([
      expect.objectContaining({
        code: 'media_down',
        level: 'warning',
        title: 'The media service isn’t answering',
      }),
    ])
    expect(healthAlerts({ ...calm, media: 'degraded' })).toEqual([])
  })

  it('says when the media service fails what it is asked, unless it is down already', () => {
    const failing = { ...calm.lastHour, mediaFailures: 7 }
    const [alert] = healthAlerts({ ...calm, lastHour: failing })
    expect(alert).toMatchObject({ code: 'media_failing', level: 'warning' })
    expect(alert?.detail).toContain('7 requests')
    expect(healthAlerts({ ...calm, media: 'down', lastHour: failing }).map((a) => a.code)).toEqual([
      'media_down',
    ])
  })

  it('says files are slow to start only over enough reads', () => {
    const slow = (reads: number, p95Ms: number | null) =>
      healthAlerts({ ...calm, lastHour: { ...calm.lastHour, firstBytes: { reads, p95Ms } } })
    expect(slow(19, 9000)).toEqual([])
    expect(slow(20, 4900)).toEqual([])
    expect(slow(20, null)).toEqual([])
    const [alert] = slow(50, 6250)
    expect(alert).toMatchObject({ code: 'downloads_slow', level: 'warning' })
    expect(alert?.detail).toContain('6.3 s or more')
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
