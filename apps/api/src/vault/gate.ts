/**
 * Lets at most `slots` pieces of work run at once; the rest wait their turn,
 * first come first served. Stretching a vault's code takes 64 MiB and the
 * thread pool that staging and password hashing share (§7.7).
 */
export class Gate {
  #free: number
  readonly #waiting: (() => void)[] = []

  constructor(slots: number) {
    this.#free = slots
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1
    else await new Promise<void>((resolve) => this.#waiting.push(resolve))
    try {
      return await work()
    } finally {
      // Hand the slot straight to the next in line, or give it back.
      const next = this.#waiting.shift()
      if (next) next()
      else this.#free += 1
    }
  }
}
