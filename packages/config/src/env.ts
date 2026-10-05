import { loadEnvFile } from 'node:process'

/** Loads optional local settings without replacing variables already in the environment. */
export function loadOptionalEnvFile(file: string): void {
  try {
    loadEnvFile(file)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    console.info(
      `[INFO] Optional environment file "${file}" not found; using environment variables and configuration defaults.`,
    )
  }
}
