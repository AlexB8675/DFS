/**
 * Whether `error` (or what it wraps: drizzle wraps the driver's error) broke
 * the unique index or constraint `name`. The index is the real guard against
 * races, so services turn this into a clean 409 instead of checking first.
 */
export function isUniqueViolation(error: unknown, name: string): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown }
    if (code === '23505' && constraint === name) return true
  }
  return false
}
