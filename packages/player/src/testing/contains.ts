// A run of bytes in a larger run, for the checks of what a browser keeps at rest (DESIGN.md §10.4).

/**
 * Where `needle` first occurs in `haystack`, or -1 when it does not occur (and for a needle of no bytes, which
 * proves nothing). It looks for the needle's first byte with the engine's own search, and compares from there.
 */
export function indexOfRun(haystack: Uint8Array, needle: Uint8Array): number {
  const first = needle[0]
  if (first === undefined) return -1
  const last = haystack.length - needle.length
  let from = haystack.indexOf(first)
  while (from !== -1 && from <= last) {
    let at = 1
    while (at < needle.length && haystack[from + at] === needle[at]) at += 1
    if (at === needle.length) return from
    from = haystack.indexOf(first, from + 1)
  }
  return -1
}
