import { randomBytes } from 'node:crypto'

/**
 * A time-ordered UUID (version 7), like PostgreSQL's `uuidv7()`, for rows
 * whose ID must be known before they are inserted: a file version's data key
 * is wrapped for its ID (DESIGN.md §7.3).
 */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(now, 0, 6)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
