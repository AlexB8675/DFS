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
