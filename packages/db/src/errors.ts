// PostgreSQL's error codes, in an error or anything it wraps: drizzle wraps
// the driver's error in its own.

/** Whether the error, or one it wraps, carries one of these SQLSTATE codes. */
export function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const { code } = current as { code?: unknown }
    if (typeof code === 'string' && codes.includes(code)) return true
  }
  return false
}

/**
 * `undefined_table` or `invalid_schema_name`: pg-boss's tables before a bot
 * first started, or an extension not created.
 */
export function isMissingTable(error: unknown): boolean {
  return hasErrorCode(error, '42P01', '3F000')
}
