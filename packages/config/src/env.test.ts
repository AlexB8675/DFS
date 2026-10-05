import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const preload = new URL('./load-env.ts', import.meta.url).href
const entry = `import { value } from './entry.ts'; console.log(JSON.stringify({ value }))`

describe('optional environment file preload', () => {
  let root: string
  let workspace: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'dfs-env-'))
    workspace = path.join(root, 'apps', 'service')
    await mkdir(workspace, { recursive: true })
    await writeFile(
      path.join(workspace, 'entry.ts'),
      'export const value = process.env.DFS_TEST_ENV_VALUE',
    )
  })

  afterEach(async () => {
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('dfs-env-')) {
      throw new Error('Unexpected environment test directory')
    }
    await rm(root, { recursive: true, force: true })
  })

  function run(value?: string) {
    const env = { ...process.env }
    delete env.DFS_TEST_ENV_VALUE
    if (value !== undefined) env.DFS_TEST_ENV_VALUE = value
    return spawnSync(
      process.execPath,
      ['--import', preload, '--input-type=module', '--eval', entry],
      { cwd: workspace, env, encoding: 'utf8' },
    )
  }

  it('labels an absent optional file as info and continues with the current environment', () => {
    const result = run('from the environment')
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('[INFO] Optional environment file "../../.env" not found;')
    expect(result.stdout).toContain('"value":"from the environment"')
  })

  it('loads quoted and multiline settings before evaluating the entry module', async () => {
    await writeFile(path.join(root, '.env'), 'DFS_TEST_ENV_VALUE="first line\nsecond line"\n')
    const result = run()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe(JSON.stringify({ value: 'first line\nsecond line' }))
  })

  it('preserves environment variables over settings from the file', async () => {
    await writeFile(path.join(root, '.env'), 'DFS_TEST_ENV_VALUE=from-file\n')
    const result = run('from the environment')
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe(JSON.stringify({ value: 'from the environment' }))
  })

  it('labels file read failures as errors and stops before running the entry module', async () => {
    await mkdir(path.join(root, '.env'))
    const result = run('must not be printed')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[ERROR] Could not load the environment file:')
    expect(result.stdout).toBe('')
  })

  it.each(['apps/api', 'apps/bot', 'packages/db'])(
    'resolves the shared preload from %s',
    (directory) => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          "console.log(import.meta.resolve('@dfs/config/load-env'))",
        ],
        { cwd: path.resolve(import.meta.dirname, '../../..', directory), encoding: 'utf8' },
      )
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout.trim()).toBe(preload)
    },
  )
})
