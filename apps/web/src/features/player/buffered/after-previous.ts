/**
 * Starts a play once the previous one on the same element has settled (§10.4): an old play that
 * is still closing would otherwise clear the new play's source from the element, since
 * the sink's close removes the element's source. A start whose `signal` aborted while it waited
 * never runs, and a previous play that rejected still lets the next one start. The result settles
 * when the play it starts does, and never rejects as long as `start` doesn't.
 */
export async function afterPrevious(
  previous: Promise<void>,
  signal: AbortSignal,
  start: () => Promise<void>,
): Promise<void> {
  await previous.catch(() => undefined)
  if (signal.aborted) return
  await start()
}
