import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig, type Config } from '@dfs/config'

/**
 * Settings for a test: development defaults, with staging, blobs and the
 * master key in a temporary directory of its own. Tests only.
 */
export async function testConfig(
  env: Record<string, string> = {},
): Promise<{ config: Config; dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dfs-api-'))
  const config = loadConfig(
    {
      NODE_ENV: 'test',
      STAGING_DIR: path.join(dir, 'staging'),
      CACHE_DIR: path.join(dir, 'cache'),
      LOCAL_BLOB_DIR: path.join(dir, 'blobs'),
      MASTER_KEY_FILE: path.join(dir, 'master-key.json'),
      ...env,
    },
    { service: 'api', rootDir: dir },
  )
  return { config, dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
