import { loadOptionalEnvFile } from './env.ts'

// Preload local settings before evaluating the service or command's imports.
// All callers run from a workspace two levels below the repository root.
try {
  loadOptionalEnvFile('../../.env')
} catch (error) {
  console.error('[ERROR] Could not load the environment file:', error)
  process.exit(1)
}
