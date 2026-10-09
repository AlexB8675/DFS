// The video player's keys (DESIGN.md §10.4), as YouTube has them. Shift+←
// and Shift+→ aren't here: they move to the previous and next file, as ←
// and → do in the viewer for other files.

export type PlayerAction =
  | { type: 'toggle' }
  | { type: 'skip'; seconds: number }
  | { type: 'volume'; by: number }
  | { type: 'mute' }
  | { type: 'fullscreen' }
  | { type: 'subtitles' }
  | { type: 'speed'; step: 1 | -1 }
  /** To a fraction of the video: 0–9 to tenths, Home to the start, End to the end. */
  | { type: 'jump'; fraction: number }

type Key = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>

/** What a key asks of the player, or `null` for a key it leaves alone. */
export function playerAction(event: Key): PlayerAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const { key } = event
  if (key === '<') return { type: 'speed', step: -1 }
  if (key === '>') return { type: 'speed', step: 1 }
  if (event.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) return null
  if (/^\d$/.test(key)) return { type: 'jump', fraction: Number(key) / 10 }
  switch (key.toLowerCase()) {
    case ' ':
    case 'k':
      return { type: 'toggle' }
    case 'j':
      return { type: 'skip', seconds: -10 }
    case 'l':
      return { type: 'skip', seconds: 10 }
    case 'arrowleft':
      return { type: 'skip', seconds: -5 }
    case 'arrowright':
      return { type: 'skip', seconds: 5 }
    case 'arrowup':
      return { type: 'volume', by: 0.05 }
    case 'arrowdown':
      return { type: 'volume', by: -0.05 }
    case 'm':
      return { type: 'mute' }
    case 'f':
      return { type: 'fullscreen' }
    case 'c':
      return { type: 'subtitles' }
    case 'home':
      return { type: 'jump', fraction: 0 }
    case 'end':
      return { type: 'jump', fraction: 1 }
    default:
      return null
  }
}

/** The speeds `<` and `>` step through, and the menu offers. */
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const

/** The next speed up or down from `rate`, staying within the list. */
export function stepSpeed(rate: number, step: 1 | -1): number {
  const index = SPEEDS.findIndex((speed) => speed >= rate - 0.001)
  const at = index === -1 ? SPEEDS.length - 1 : index
  // A rate between two steps goes to the nearer one in the asked direction.
  const exact = SPEEDS[at] !== undefined && Math.abs((SPEEDS[at] ?? 0) - rate) < 0.001
  const next = step === 1 ? (exact ? at + 1 : at) : at - 1
  return SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, next))] ?? 1
}
