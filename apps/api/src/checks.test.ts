import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MetricName } from '@dfs/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Checks, reach } from './checks.ts'

// The API's checks of Discord, the internet and itself (DESIGN.md §16),
// against servers on this machine: one answers, one fails, one says nothing.

let server: http.Server
let base: string
const asked: string[] = []

beforeAll(async () => {
  server = http.createServer((request, response) => {
    asked.push(request.url ?? '')
    if (request.url === '/silent') return
    response.writeHead(request.url === '/broken' ? 503 : 204).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
})

const timed: { name: MetricName; ms: number }[] = []
const counted: MetricName[] = []
const metrics = {
  time: (name: MetricName, ms: number) => {
    timed.push({ name, ms })
  },
  record: (name: MetricName) => {
    counted.push(name)
  },
}

beforeEach(() => {
  asked.length = 0
  timed.length = 0
  counted.length = 0
})

function checks(discord: string, internet: string, timeoutMs = 200) {
  return new Checks(metrics, {
    urls: { discord: `${base}${discord}`, internet: `${base}${internet}` },
    timeoutMs,
  })
}

describe('checks (§16)', () => {
  it('times each answer, counts what failed, and asks the API itself', async () => {
    const check = checks('/discord', '/broken')
    await check.check(`${base}/api/health`)
    expect(asked.sort()).toEqual(['/api/health', '/broken', '/discord'])
    expect(timed.map((entry) => entry.name)).toEqual(['check.discord.ms'])
    expect(timed[0]?.ms).toBeGreaterThan(0)
    // A server error is no answer.
    expect(counted).toEqual(['check.internet.failures'])
    expect(check.reading('discord')).toEqual({
      checked: true,
      down: false,
      failures: 0,
      ms: timed[0]?.ms,
    })
  })

  it('gives up on a silent target after the timeout', async () => {
    const started = performance.now()
    await checks('/silent', '/internet', 100).check()
    expect(performance.now() - started).toBeGreaterThanOrEqual(90)
    expect(counted).toEqual(['check.discord.failures'])
  })

  it('reads a target as down only after three failures in a row, and not before checking', async () => {
    const check = checks('/broken', '/internet')
    expect(check.reading('discord')).toEqual({ checked: false, down: false, failures: 0, ms: null })
    expect(reach(check.reading('discord'))).toEqual({ status: 'ok', detail: 'Checking…' })

    await check.check()
    expect(reach(check.reading('discord'))).toEqual({
      status: 'degraded',
      detail: 'No answer · 1 check failed',
    })
    await check.check()
    await check.check()
    expect(check.reading('discord')).toMatchObject({ down: true, failures: 3 })
    expect(reach(check.reading('discord'))).toEqual({ status: 'down', detail: 'Not answering' })
    expect(check.reading('internet')).toMatchObject({ down: false, failures: 0 })
  })

  it('shows the answer time as the overview does', () => {
    const answered = { checked: true, down: false, failures: 0 }
    expect(reach({ ...answered, ms: 4.2 })).toEqual({ status: 'ok', detail: '4.2 ms' })
    expect(reach({ ...answered, ms: 123.4 })).toEqual({ status: 'ok', detail: '123 ms' })
    expect(reach({ ...answered, failures: 2, ms: 98 })).toEqual({
      status: 'degraded',
      detail: '98 ms · 2 checks failed',
    })
  })

  it('stops at once, cutting short a check under way, which counts for nothing', async () => {
    const check = checks('/silent', '/silent', 5_000)
    check.start(`${base}/api/health`)
    while (asked.filter((url) => url === '/silent').length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const started = performance.now()
    await check.stop()
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(counted).toEqual([])
    expect(check.reading('discord').checked).toBe(false)
  })
})
