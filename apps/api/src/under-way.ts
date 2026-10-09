// How many of something are under way, for a gauge (DESIGN.md §16). Gauges
// are sampled every few seconds, which would miss a burst between two
// samples, so a sample reads the most there were since the last one.

export class UnderWay {
  #now = 0
  #peak = 0

  /** One more is under way; call what it returns once it is over (only the first call counts). */
  enter(): () => void {
    this.#now += 1
    this.#peak = Math.max(this.#peak, this.#now)
    let left = false
    return () => {
      if (left) return
      left = true
      this.#now -= 1
    }
  }

  /** How many are under way now. */
  get now(): number {
    return this.#now
  }

  /** The most under way since the last sample, which starts the next one from now. */
  sample(): number {
    const peak = this.#peak
    this.#peak = this.#now
    return peak
  }
}
