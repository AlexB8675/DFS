/** The whole file's length, from a `206`'s `Content-Range: bytes 0-99/1234`. */
export function rangeTotal(response: Response): number | undefined {
  const total = /\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')?.[1]
  return total === undefined ? undefined : Number(total)
}
