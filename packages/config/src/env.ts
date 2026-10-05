import { loadEnvFile } from 'node:process'

/**
 * Loads optional local settings without replacing variables already in the
 * environment. Without the file, the defaults apply, as they usually do.
 */
export function loadOptionalEnvFile(file: string): void {
  try {
    loadEnvFile(file)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
}
