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
