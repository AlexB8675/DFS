import { describe, expect, it } from 'vitest'
import { GAP_EDGE_SECONDS, REOPENS_MAX, STUCK_MS } from '../limits.ts'
import { Watchdog } from './watchdog.ts'
import type { WatchSample } from './watchdog.ts'

// The watchdog's ladder (DESIGN.md §10.4): gap, refeed, reopen, then stuck, one
// rung each STUCK_MS while the play stays frozen.

function rig(maxFrameSeconds: number | null = null) {
  let time = 0
  const dog = new Watchdog(() => time, maxFrameSeconds)
  const base: WatchSample = {
    at: 10,
    frames: 100,
    readyState: 2,
    paused: false,
    seeking: false,
    seeked: false,
    ended: false,
    buffered: [[0, 20]],
    holding: false,
    hidden: false,
    feeding: false,
    trackEnds: [
      { name: 'picture', end: 20 },
      { name: 'sound', end: 20 },
    ],
  }
  return {
    tick(ms: number, patch: Partial<WatchSample> = {}) {
      time += ms
      return dog.observe({ ...base, ...patch })
    },
    base,
  }
}

/** Observe a frozen play once at its start, then step to the first stuck sample. */
function freeze(r: ReturnType<typeof rig>, patch: Partial<WatchSample> = {}) {
  expect(r.tick(0, patch)).toBeNull()
  expect(r.tick(STUCK_MS - 500, patch)).toBeNull()
  return r.tick(500, patch)
}

describe('Watchdog', () => {
  it('refeeds a frozen clock with data present, then reopens each STUCK_MS, then reports stuck', () => {
    const r = rig()
    expect(freeze(r)).toEqual({ action: 'refeed' })
    expect(r.tick(STUCK_MS - 500)).toBeNull()
    for (let i = 0; i < REOPENS_MAX; i++) {
      expect(r.tick(500)).toEqual({ action: 'reopen' })
      expect(r.tick(STUCK_MS - 500)).toBeNull()
    }
    const last = r.tick(500)
    expect(last?.action).toBe('stuck')
    if (last?.action === 'stuck') {
      expect(last.detail.length).toBeLessThan(300)
      expect(last.detail).toContain(String(REOPENS_MAX))
    }
  })

  it('steps over a small gap at the range end first, then refeeds', () => {
    const r = rig()
    const patch = {
      at: 19.9,
      buffered: [
        [0, 20],
        [20.3, 40],
      ] as [number, number][],
    }
    expect(freeze(r, patch)).toEqual({ action: 'gap', to: 20.3 })
    expect(r.tick(STUCK_MS, patch)).toEqual({ action: 'refeed' })
  })

  it('steps over a gap when the playhead is in no range', () => {
    const r = rig()
    const patch = {
      at: 20.5,
      buffered: [
        [0, 20],
        [21, 40],
      ] as [number, number][],
    }
    expect(freeze(r, patch)).toEqual({ action: 'gap', to: 21 })
  })

  it('does not step a gap wider than the step, or from far inside a range', () => {
    const wide = rig()
    expect(
      freeze(wide, {
        at: 19.9,
        buffered: [
          [0, 20],
          [23, 40],
        ],
      }),
    ).toEqual({ action: 'refeed' })
    const inside = rig()
    expect(
      freeze(inside, {
        at: 10,
        buffered: [
          [0, 20],
          [20.1, 40],
        ],
      }),
    ).toEqual({ action: 'refeed' })
    expect(GAP_EDGE_SECONDS).toBeLessThan(10)
  })

  it('refeeds once when the data is missing, then reports stuck, naming the track that ends at the playhead (A1)', () => {
    const r = rig()
    const patch = {
      buffered: [] as [number, number][],
      trackEnds: [
        { name: 'picture', end: 30 },
        { name: 'sound', end: 10 },
      ],
    }
    expect(freeze(r, patch)).toEqual({ action: 'refeed' })
    const last = r.tick(STUCK_MS, patch)
    expect(last?.action).toBe('stuck')
    if (last?.action === 'stuck') {
      expect(last.detail).toContain('sound')
      expect(last.detail).toContain('10.0')
      expect(last.detail).not.toContain('picture')
    }
  })

  it("gives a viewer's seek a new ladder, but not the engine's own seeks (F1)", () => {
    const r = rig()
    const patch = {
      buffered: [] as [number, number][],
      trackEnds: [
        { name: 'picture', end: 30 },
        { name: 'sound', end: 10 },
      ],
    }
    expect(freeze(r, patch)).toEqual({ action: 'refeed' })
    // The engine's own seek (a refeed's serve) between: the ladder stays, so the next futile sample is stuck.
    expect(r.tick(500, { ...patch, seeking: true })).toBeNull()
    expect(r.tick(500, patch)).toBeNull()
    // The viewer's seek to another place, stuck with no data: a new ladder, so a refeed there first.
    const seek = { ...patch, at: 50, seeking: true, seeked: true }
    expect(r.tick(500, seek)).toBeNull()
    const there = { ...patch, at: 50 }
    expect(r.tick(500, there)).toBeNull()
    expect(r.tick(STUCK_MS - 500, there)).toEqual({ action: 'refeed' })
    expect(r.tick(STUCK_MS, there)?.action).toBe('stuck')
  })

  it('refeeds again and again while a feed waits for bytes, never reporting stuck (R39)', () => {
    const r = rig()
    const patch = { buffered: [] as [number, number][], feeding: true }
    expect(freeze(r, patch)).toEqual({ action: 'refeed' })
    for (let i = 0; i < REOPENS_MAX + 2; i++) {
      expect(r.tick(STUCK_MS, patch)).toEqual({ action: 'refeed' })
    }
  })

  it.each([
    ['paused', { paused: true }],
    ['seeking', { seeking: true }],
    ['holding', { holding: true }],
    ['ended', { ended: true }],
  ])('is never stuck while %s', (_name, patch) => {
    const r = rig()
    for (let i = 0; i < 20; i++) expect(r.tick(500, patch)).toBeNull()
  })

  it('counts from the resume, not from before a pause', () => {
    const r = rig()
    expect(r.tick(0)).toBeNull()
    for (let i = 0; i < 10; i++) expect(r.tick(500, { paused: true })).toBeNull()
    expect(r.tick(500)).toBeNull()
    expect(r.tick(STUCK_MS - 1000)).toBeNull()
    expect(r.tick(500)).toEqual({ action: 'refeed' })
  })

  it('does not count a sleep as stuck', () => {
    const r = rig()
    expect(r.tick(0)).toBeNull()
    expect(r.tick(10_000)).toBeNull()
    expect(r.tick(STUCK_MS - 500)).toBeNull()
    expect(r.tick(500)).toEqual({ action: 'refeed' })
  })

  it('is not stuck while the clock stands but the frames move', () => {
    const r = rig()
    let frames = 100
    for (let i = 0; i < 20; i++) expect(r.tick(500, { frames: ++frames })).toBeNull()
  })

  it('is not stuck while the frames stand but the clock moves, with no frame length known', () => {
    const r = rig(null)
    let at = 10
    for (let i = 0; i < 40; i++) expect(r.tick(500, { at: (at += 0.5) })).toBeNull()
  })

  it('catches a frozen picture once the clock has moved a frame plus STUCK_MS', () => {
    const r = rig(0.04)
    let at = 10
    expect(r.tick(0, { at })).toBeNull()
    // 2.04 s of media at 0.5 s a sample: still within it at 2.0 s.
    for (let i = 0; i < 4; i++) expect(r.tick(500, { at: (at += 0.5) })).toBeNull()
    expect(r.tick(500, { at: at + 0.5 })).toEqual({ action: 'refeed' })
  })

  it('goes back to the first rung when the play moves, keeping the reopen count', () => {
    const r = rig()
    expect(freeze(r)).toEqual({ action: 'refeed' })
    expect(r.tick(STUCK_MS)).toEqual({ action: 'reopen' })
    // It moves again.
    expect(r.tick(500, { at: 11, frames: 130 })).toBeNull()
    const patch = { at: 11, frames: 130 }
    expect(r.tick(STUCK_MS, patch)).toEqual({ action: 'refeed' })
    expect(r.tick(STUCK_MS, patch)).toEqual({ action: 'reopen' })
    expect(r.tick(STUCK_MS, patch)).toEqual({ action: 'reopen' })
    expect(r.tick(STUCK_MS, patch)?.action).toBe('stuck')
  })
  it.each([
    ['a lone range', [[0, 20]]],
    [
      'a gap wider than the step',
      [
        [0, 20],
        [23, 40],
      ],
    ],
  ] as [string, [number, number][]][])(
    'refeeds once, never reopening, then reports stuck, at the end of %s (A1)',
    (_name, buffered) => {
      const r = rig()
      const patch = { at: 19.9, buffered }
      expect(freeze(r, patch)).toEqual({ action: 'refeed' })
      expect(r.tick(STUCK_MS, patch)?.action).toBe('stuck')
    },
  )

  it('keeps the gap rung for when a target appears', () => {
    const r = rig()
    const at = 19.9
    expect(freeze(r, { at, buffered: [[0, 20]] })).toEqual({ action: 'refeed' })
    expect(
      r.tick(STUCK_MS, {
        at,
        buffered: [
          [0, 20],
          [20.3, 40],
        ],
      }),
    ).toEqual({
      action: 'gap',
      to: 20.3,
    })
    expect(
      r.tick(STUCK_MS, {
        at,
        buffered: [
          [0, 20],
          [20.3, 40],
        ],
      }),
    ).toEqual({
      action: 'refeed',
    })
  })

  it('walks the whole ladder through the engine own seeks and reopens', () => {
    const r = rig()
    expect(freeze(r)).toEqual({ action: 'refeed' })
    let frames = 100
    for (let i = 0; i < REOPENS_MAX; i++) {
      expect(r.tick(STUCK_MS, { frames })).toEqual({ action: 'reopen' })
      // The engine reopens: the element seeks, its frame count starts again.
      for (let k = 0; k < 3; k++) expect(r.tick(100, { seeking: true })).toBeNull()
      frames = 0
      expect(r.tick(100, { frames })).toBeNull()
      expect(r.tick(STUCK_MS - 200, { frames })).toBeNull()
    }
    expect(r.tick(200, { frames })?.action).toBe('stuck')
  })

  it('refeeds after a gap whose seek the engine made', () => {
    const r = rig()
    const buffered: [number, number][] = [
      [0, 20],
      [20.3, 40],
    ]
    expect(freeze(r, { at: 19.9, buffered })).toEqual({ action: 'gap', to: 20.3 })
    for (let k = 0; k < 3; k++)
      expect(r.tick(100, { at: 20.3, seeking: true, buffered })).toBeNull()
    const landed = { at: 20.3, buffered }
    expect(r.tick(100, landed)).toBeNull()
    expect(r.tick(STUCK_MS, landed)).toEqual({ action: 'refeed' })
  })

  it('does not call a hidden tab with a moving clock a frozen picture', () => {
    const r = rig(0.04)
    let at = 10
    for (let i = 0; i < 20; i++) expect(r.tick(500, { at: (at += 0.5), hidden: true })).toBeNull()
  })

  it('still catches a frozen clock in a hidden tab', () => {
    const r = rig(0.04)
    expect(freeze(r, { hidden: true })).toEqual({ action: 'refeed' })
  })

  it('does not call a forward jump of the clock a frozen picture before STUCK_MS of frames standing', () => {
    const r = rig(0.04)
    expect(r.tick(0, { at: 10 })).toBeNull()
    expect(r.tick(500, { at: 10 })).toBeNull()
    expect(r.tick(500, { at: 20 })).toBeNull()
  })

  it('restarts its count when the clock goes backward', () => {
    const r = rig()
    expect(r.tick(0, { at: 10 })).toBeNull()
    expect(r.tick(1900, { at: 10 })).toBeNull()
    expect(r.tick(100, { at: 5 })).toBeNull()
    expect(r.tick(STUCK_MS - 500, { at: 5 })).toBeNull()
    expect(r.tick(500, { at: 5 })).toEqual({ action: 'refeed' })
  })

  it('still catches a frozen clock after now() goes back', () => {
    const r = rig()
    expect(r.tick(0)).toBeNull()
    expect(r.tick(500)).toBeNull()
    expect(r.tick(-5000)).toBeNull()
    expect(r.tick(STUCK_MS - 500)).toBeNull()
    expect(r.tick(500)).toEqual({ action: 'refeed' })
  })

  it('names the ready state in the stuck detail', () => {
    const r = rig()
    let last = freeze(r, { readyState: 3 })
    for (let i = 0; i < REOPENS_MAX + 1; i++) last = r.tick(STUCK_MS, { readyState: 3 })
    expect(last?.action === 'stuck' && last.detail).toContain('ready state 3')
  })
})
