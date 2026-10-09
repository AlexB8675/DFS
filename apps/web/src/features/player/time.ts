/**
 * A time in a video, as players show it: `0:07`, `12:34`, `1:02:03`. Hours
 * appear when the video has them (`scale`), so the time doesn't jump in width.
 */
export function formatPlayTime(seconds: number, scale = seconds): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor(whole / 60) % 60
  const rest = String(whole % 60).padStart(2, '0')
  if (hours > 0 || (Number.isFinite(scale) && scale >= 3600)) {
    return `${String(hours)}:${String(minutes).padStart(2, '0')}:${rest}`
  }
  return `${String(minutes)}:${rest}`
}

/** A gap this small before the time still counts as loaded up to it: ranges meet at keyframes. */
const LOADED_SLACK_S = 0.5

/**
 * How far it has loaded from where it plays, as a seek bar shows it (as
 * YouTube does): the end of the loaded range the time is in, else the time
 * itself. Ranges elsewhere, behind or after a seek, aren't drawn.
 */
export function loadedUntil(
  buffered: readonly (readonly [number, number])[],
  time: number,
): number {
  const range = buffered.find(([start, end]) => start <= time + LOADED_SLACK_S && end >= time)
  return range ? Math.max(range[1], time) : time
}
