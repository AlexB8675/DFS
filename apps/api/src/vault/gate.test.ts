import { describe, expect, it } from 'vitest'
import { Gate } from './gate.ts'

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('Gate', () => {
  it('lets only as many run at once as it has slots, in the order they came', async () => {
    const gate = new Gate(2)
    let running = 0
    let mostRunning = 0
    const results = await Promise.all(
      [0, 1, 2, 3, 4, 5].map((index) =>
        gate.run(async () => {
          running += 1
          mostRunning = Math.max(mostRunning, running)
          await pause(20)
          running -= 1
          return index
        }),
      ),
    )
    expect(mostRunning).toBe(2)
    expect(results).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('gives a slot back when the work throws', async () => {
    const gate = new Gate(2)
    await expect(gate.run(() => Promise.reject(new Error('no')))).rejects.toThrow('no')

    let running = 0
    let mostRunning = 0
    await Promise.all(
      [0, 1].map(() =>
        gate.run(async () => {
          running += 1
          mostRunning = Math.max(mostRunning, running)
          await pause(20)
          running -= 1
        }),
      ),
    )
    expect(mostRunning).toBe(2)
  })
})
