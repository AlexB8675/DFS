import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { createTestDatabase } from '@dfs/db/testing'
import { expect, inject, it } from 'vitest'
import { testConfig } from './testing/config.ts'

const run = promisify(execFile)
const rootDir = path.resolve(import.meta.dirname, '../../..')

/** A PowerShell literal, including paths with spaces or apostrophes. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function unusedPorts(): Promise<number[]> {
  const servers = [createServer(), createServer(), createServer()]
  try {
    await Promise.all(
      servers.map(
        (server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
      ),
    )
    return servers.map((server) => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No test port')
      return address.port
    })
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) =>
            server.close(() => {
              resolve()
            }),
          ),
      ),
    )
  }
}

it.skipIf(process.platform !== 'win32')(
  'stops pnpm dev and releases every server port after one console Ctrl+C',
  async () => {
    const pnpm = process.env.npm_execpath
    if (!pnpm) throw new Error('Run this check through pnpm')
    const database = await createTestDatabase(inject('testPostgres'))
    const setup = await testConfig({ DATABASE_URL: database.url })
    const [apiPort, botPort, webPort] = await unusedPorts()
    if (!apiPort || !botPort || !webPort) throw new Error('Missing test ports')
    const stdoutFile = path.join(setup.dir, 'dev.stdout.log')
    const stderrFile = path.join(setup.dir, 'dev.stderr.log')
    const scriptFile = path.join(setup.dir, 'shutdown.ps1')
    // A private, hidden console lets this test send an actual Windows Ctrl+C
    // without interrupting Vitest or another developer's server. child.kill()
    // on Windows would force-terminate the process and miss the batch-shell bug.
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DevConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint id);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint control, uint group);
}
'@
function Test-Port($port) {
  $socket = [System.Net.Sockets.TcpClient]::new()
  try { $socket.Connect('127.0.0.1', $port); return $true }
  catch { return $false }
  finally { $socket.Dispose() }
}
$ports = @(${apiPort}, ${botPort}, ${webPort})
$startOptions = @{
  FilePath = ${literal(process.execPath)}
  ArgumentList = @(${literal(`"${pnpm}"`)}, 'run', 'dev', '--host=127.0.0.1', '--port=${webPort}')
  WorkingDirectory = ${literal(rootDir)}
  WindowStyle = 'Hidden'
  PassThru = $true
  RedirectStandardOutput = ${literal(stdoutFile)}
  RedirectStandardError = ${literal(stderrFile)}
}
$dev = Start-Process @startOptions
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(25)
  do {
    if ($dev.HasExited) { throw 'The dev launcher exited before all services started.' }
    $ready = @($ports | Where-Object { Test-Port $_ }).Count -eq $ports.Count
    if (-not $ready) { Start-Sleep -Milliseconds 100 }
  } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
  if (-not $ready) { throw 'The dev servers did not start on their test ports.' }
  [DevConsole]::FreeConsole() | Out-Null
  if (-not [DevConsole]::AttachConsole($dev.Id)) { throw 'Could not attach the test console.' }
  [DevConsole]::SetConsoleCtrlHandler([IntPtr]::Zero, $true) | Out-Null
  if (-not [DevConsole]::GenerateConsoleCtrlEvent(0, 0)) { throw 'Could not send Ctrl+C.' }
  Start-Sleep -Milliseconds 100
  [DevConsole]::FreeConsole() | Out-Null
  if (-not $dev.WaitForExit(5000)) { throw 'One Ctrl+C did not stop the dev launcher.' }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $open = @($ports | Where-Object { Test-Port $_ })
    if ($open.Count -gt 0) { Start-Sleep -Milliseconds 100 }
  } while ($open.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
  if ($open.Count -gt 0) { throw 'A dev server still owns a test port after shutdown.' }
  Write-Output 'One Ctrl+C stopped the dev launcher and released all three ports.'
} finally {
  [DevConsole]::FreeConsole() | Out-Null
  if (-not $dev.HasExited) { taskkill /PID $dev.Id /T /F | Out-Null }
}
`
    try {
      await writeFile(scriptFile, script)
      const result = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
        {
          windowsHide: true,
          timeout: 40_000,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            DATABASE_URL: database.url,
            BLOB_STORE: 'local',
            API_PORT: String(apiPort),
            BOT_PORT: String(botPort),
            MASTER_KEY_FILE: setup.config.masterKeyFile,
            STAGING_DIR: setup.config.stagingDir,
            CACHE_DIR: setup.config.cacheDir,
            LOCAL_BLOB_DIR: setup.config.localBlobDir,
          },
        },
      )
      expect(result.stdout).toContain('released all three ports')
      expect(result.stderr).toBe('')
    } catch (error) {
      const logs = await Promise.allSettled([
        readFile(stdoutFile, 'utf8'),
        readFile(stderrFile, 'utf8'),
      ])
      throw new Error(logs.map((log) => (log.status === 'fulfilled' ? log.value : '')).join('\n'), {
        cause: error,
      })
    } finally {
      await database.drop()
      await setup.cleanup()
    }
  },
  45_000,
)
