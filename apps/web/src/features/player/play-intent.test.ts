import { describe, expect, it } from 'vitest'
import { PlayIntent } from './play-intent'

describe('PlayIntent', () => {
  it('plays at once when nothing holds', () => {
    expect(new PlayIntent().play(false)).toBe('play')
  })

  it('waits for a hold to end rather than playing into it, and still wants the play', () => {
    const intent = new PlayIntent()
    expect(intent.play(true)).toBe('wait')
    expect(intent.wanted).toBe(true)
  })

  it('wants no play after a pause, so a hold that ends does not play', () => {
    const intent = new PlayIntent()
    intent.pause()
    expect(intent.wanted).toBe(false)
  })

  it('wants a play again at a new start', () => {
    const intent = new PlayIntent()
    intent.pause()
    intent.restart()
    expect(intent.wanted).toBe(true)
  })

  it('wants a play that the element makes on its own, as Picture-in-Picture’s button does', () => {
    const intent = new PlayIntent()
    intent.pause()
    intent.played()
    expect(intent.wanted).toBe(true)
  })

  it('pauses a wanted play that the engine holds, though the element is paused already, so the hold’s end does not play', () => {
    const intent = new PlayIntent()
    expect(intent.toggle(true, true)).toBe('pause')
    expect(intent.wanted).toBe(false)
  })

  it('wants the play again at a second toggle during the hold, and waits for the hold to end', () => {
    const intent = new PlayIntent()
    intent.toggle(true, true)
    expect(intent.toggle(true, true)).toBe('wait')
    expect(intent.wanted).toBe(true)
  })

  it('toggles as the element shows when nothing holds', () => {
    const intent = new PlayIntent()
    expect(intent.toggle(false, false)).toBe('pause')
    expect(intent.toggle(false, true)).toBe('play')
  })
})

describe('PlayIntent listeners', () => {
  function watched() {
    const intent = new PlayIntent()
    const told: boolean[] = []
    intent.subscribe(() => told.push(intent.wanted))
    return { intent, told }
  }

  it('tells a pause, a play, a restart and a played, when wanted changes', () => {
    const { intent, told } = watched()
    intent.pause()
    intent.play(false)
    intent.pause()
    intent.restart()
    intent.pause()
    intent.played()
    expect(told).toEqual([false, true, false, true, false, true])
  })

  it('tells a toggle that changes wanted, in a hold and out of one', () => {
    const { intent, told } = watched()
    intent.toggle(true, true)
    intent.toggle(true, true)
    intent.toggle(false, false)
    intent.toggle(false, true)
    expect(told).toEqual([false, true, false, true])
  })

  it('tells nothing when wanted stays as it was', () => {
    const { intent, told } = watched()
    intent.play(false)
    intent.restart()
    intent.played()
    intent.toggle(false, true)
    intent.play(true)
    expect(told).toEqual([])
  })

  it('stops telling a listener that unsubscribed', () => {
    const intent = new PlayIntent()
    let count = 0
    const off = intent.subscribe(() => count++)
    off()
    intent.pause()
    expect(count).toBe(0)
  })
})
