/**
 * How long a new play waits for the previous one on the element to settle. A play that never
 * settles (a browser that never ends a SourceBuffer operation) must not block every later start,
 * so past this the new play starts anyway, as it did before the wait.
 */
export const PREVIOUS_PLAY_WAIT_MS = 5000

/**
 * Starts a play once the previous one on the same element has settled (§10.4): an old play that
 * is still closing would otherwise clear the new play's source from the element, since
 * the sink's close removes the element's source. A start whose `signal` aborted while it waited
 * never runs, and a previous play that rejected still lets the next one start. The wait is at
 * most `PREVIOUS_PLAY_WAIT_MS`. The result settles when the play it starts does, and never
 * rejects as long as `start` doesn't.
 */
export async function afterPrevious(
  previous: Promise<void>,
  signal: AbortSignal,
  start: () => Promise<void>,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PREVIOUS_PLAY_WAIT_MS)
  })
  await Promise.race([previous.catch(() => undefined), waited])
  clearTimeout(timer)
  if (signal.aborted) return
  await start()
}
