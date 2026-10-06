# Testing DFS locally

Run these commands in PowerShell from `D:\Dev\Claude\Code\dfs`. Use Node.js 24 or
newer and start Docker Desktop before running integration tests.

## Set up pnpm

The project uses pnpm 10.34.6 through Corepack. Turborepo also invokes `pnpm`
directly, so its shim must be on your PATH. A project-local setup avoids needing
to write into Node's installation directory:

```powershell
New-Item -ItemType Directory -Force .data/check-bin | Out-Null
corepack enable pnpm --install-directory .data/check-bin
$env:PATH = (Join-Path $PWD '.data/check-bin') + [IO.Path]::PathSeparator + $env:PATH
pnpm --version
```

The version should be `10.34.6`. Repeat the PATH line in each new terminal. If
dependencies are not installed yet, run `pnpm install --frozen-lockfile`.

## Run all automated checks

```powershell
pnpm format:check
if ($LASTEXITCODE -ne 0) { throw 'Formatting check failed.' }
pnpm exec turbo run typecheck lint test build --force
if ($LASTEXITCODE -ne 0) { throw 'Workspace checks failed.' }
git diff --check
```

`--force` reruns every task instead of reusing cached results. Integration tests
create their own PostgreSQL 18 containers and temporary databases; you do not
need to start the development database for this step. The ordinary suite skips
the optional live-stack test until it is configured below.

The suite covers API contracts, migrations, encryption, storage, authentication,
uploads, downloads, archives, shares, trash, concurrent tree changes, bot
lifecycle, browser upload scheduling, live events, and cache updates.

## Start the real application

Set this in `apps/web/.env.local`:

```dotenv
VITE_API_MOCKS=off
```

This makes the browser use the real API. Set `BLOB_STORE=local` in the root
`.env` for local storage. The root `.env.example` documents the other settings.

Start and migrate the development database:

```powershell
pnpm db:up
pnpm db:migrate
```

On a fresh database, create the first account:

```powershell
pnpm dfs owner --username owner
```

It prints a temporary password. If the owner already exists, this command resets
their password and signs them out everywhere; use your existing login instead
when you only want to test the application.

Start the application:

```powershell
pnpm dev
```

Open `http://localhost:5173`, sign in, and choose a permanent password if prompted.
The API runs on port 3000 and the bot on port 3001.

Press Ctrl+C once and check that the terminal prompt returns. Run `pnpm dev`
again to confirm all three ports are available. On Windows, this command checks
the same with a real console Ctrl+C, on its own database and ports (it starts
the whole stack, so the ordinary suite skips it):

```powershell
pnpm --filter @dfs/api check:dev-shutdown
```

## Connect Discord

Development shares the Discord server and bot with production, but keeps to
its own `DFS Dev` category and never connects to the gateway (D25). In the root
`.env`, set `DISCORD_BOT_TOKEN` (Developer Portal, Application → Bot) and
`DISCORD_GUILD_ID`, and keep `DISCORD_CATEGORY_NAME=DFS Dev` and
`DISCORD_GATEWAY=off`. Git ignores `.env`; never commit the token. Then run:

```powershell
pnpm dfs setup
```

It creates the category and its channels where they are missing, hidden from
everyone but the bot, and registers them for storage. It says what it changed;
run again, it changes nothing. The bot's role needs View Channels, Send
Messages, Attach Files, Read Message History and Manage Messages, plus Manage
Channels and Manage Roles for this command.

Set `BLOB_STORE=discord` in `.env` to store files in those channels, and
restart `pnpm dev`. To check what DFS relies on from Discord (posting with a
nonce, Range reads from the CDN, signing URLs again, deleting) against
`#storage-03`, run:

```powershell
pnpm --filter @dfs/storage check:discord
```

It deletes everything it posts. Development shares Discord's rate limits with
production, so keep load tests on `BLOB_STORE=local` or `chaos`.

## Test in the browser

Use disposable folders and files for these checks:

1. Upload a nested folder containing small files, an empty file, and a file of
   at least 25 MiB. Check that each file lands in the correct folder and reaches
   the stored state.
2. Pause and resume the large upload. In browser developer tools, temporarily
   select the offline network mode, restore connectivity, and retry any failed
   uploads. Progress should recover and the downloaded bytes should match.
3. Upload the same filename again with different contents. Check that the new
   contents download correctly and storage usage remains consistent.
4. Rename and move folders, including from two browser windows. The final name
   and location should agree in both windows. Open folder trees and breadcrumbs
   to check that they update.
5. Trash a parent folder while another window uploads or moves an item into it.
   The completed tree change must leave the item hidden with its trashed parent.
   Restore the folder and check its descendants; empty a disposable trash item
   and check that it disappears permanently.
6. Download a folder as a ZIP, then a selection containing multiple folders.
   Check nested paths, empty folders, and selections with duplicate top-level
   names. Try renaming a selected folder while the ZIP is being prepared.
7. Open a password-protected share in a private browser window. Check a wrong
   password, the right password, changing the password, revocation, and a link
   with a download limit of one.
8. As an admin, moderate a disposable folder while its owner has it open. Check
   that it moves to the owner's trash and that the reason appears there.
9. Open Admin → Overview while uploading. Within a minute the history graphs
   show the bytes received and posted to Discord; switch the range between
   1 h and 24 h and check that the graphs keep their place while the new range
   loads. Point at a graph, then focus it with Tab and use the arrow keys: the
   readout lists every line at that time. The table button shows the same
   values. Stop the bot (Ctrl+C in its terminal, or end `pnpm dev` and start
   only the API): within a few seconds the overview says the bot isn't
   answering, and the alert goes once the bot is back.
10. Open Admin → Monitoring. Every section loads in one request each; graphs
    for things that haven't happened yet are flat, never broken.
11. Open Admin → Storage. Seal packs now while uploading small files: the task
    shows as waiting, then done with how many packs it sealed, and the audit log
    records it. With Discord storage, Create channel asks first, then adds the
    next `storage-NN` to `DFS Dev`; clicking a task again while it waits says
    it is under way. Stop the bot and a task is refused until it is back.
12. Open Admin → Access in one browser, signed in as an admin, and sign in
    as another user in a private window. The second session shows with its
    browser and address; Sign out ends it, and the private window's next
    click asks to sign in again. Share a file as that user, then turn the link
    off from Access: opening the link says it was turned off. In the audit
    log, choose Sharing and type the file's name.
13. Open Admin → System. The settings match your `.env`, marked set or default,
    and with the service that reads them where only one does; no secret shows
    its value. Stop the bot: the page says it didn't answer, and the bot's
    secret shows as unknown. Clear the frame cache after downloading a
    file stored in Discord: the cache shows 0 B, and the next download reads
    from Discord again. On Admin → Database, vacuum a table: its Vacuumed
    column says just now.
14. Open Admin → Database. In a terminal, hold a query open:
    `docker exec -it dfs-dev-postgres-1 psql -U dfs -d dfs -c "SELECT pg_sleep(120)"`.
    Within 10 s it shows under Running now; Cancel query stops it (psql says
    `canceling statement due to user request`), and the audit log records it.
    The slowest statements list fills in as the app works.

For an exact round-trip comparison, compare the SHA-256 hashes of the original
and downloaded files:

```powershell
Get-FileHash -Algorithm SHA256 'C:\path\to\original.bin'
Get-FileHash -Algorithm SHA256 'C:\path\to\downloaded.bin'
```

## Run the live end-to-end checks

Keep `pnpm dev` running. In a second terminal, apply the pnpm PATH line above and
set credentials for a disposable test account:

```powershell
$env:DFS_API = 'http://127.0.0.1:3000'
$env:DFS_ORIGIN = 'http://localhost:5173'
$env:DFS_USERNAME = 'your-test-user'
$credential = Get-Credential -UserName $env:DFS_USERNAME -Message 'DFS test account'
$env:DFS_PASSWORD = $credential.GetNetworkCredential().Password
pnpm --filter @dfs/api check:end-to-end
```

This creates a new test workspace, uploads and downloads 1,000 small files and a
1 GiB file, verifies their bytes, and runs 12 clients uploading versions of the
same names concurrently. Test workspaces remain in this account for inspection.
The account needs enough free quota for the files and retained versions. For a
smaller smoke check, set these in that terminal before running the command:

```powershell
$env:DFS_SMALL_FILES = '100'
$env:DFS_LARGE_MB = '64'
```

Against Discord storage, run only that smoke check: the full run sends over a
gigabyte through the rate limits production shares. Run the full-size check
with `BLOB_STORE=local`. `$env:DFS_SMALL_KB` sets the small files' size, and
`$env:DFS_CONCURRENT = 'off'` skips the last step.

A failing check names the step and the request that failed. If one stops
partway with no message at all, read the exit code pnpm reports: a Windows
exception code such as `3221225477` (0xC0000005) or `3221225725` (0xC00000FD)
means the Node.js process running the check crashed, not the stack it was
checking. Run it again; uploads it left open are released after 24 hours. Run
the checks through pnpm as shown: started directly from Git Bash, a crash
loses that exit code. Record any such stop in
[BACKEND.md §8.1](BACKEND.md#81-unexplained-failures-to-watch-for), which keeps
the failures nobody has explained yet.

For the upload engine's fault check, set `BLOB_STORE=chaos` in the root `.env`,
restart `pnpm dev`, and run in the second terminal:

```powershell
$env:DFS_CHAOS_SEED = '20261005'
pnpm --filter @dfs/web check:engine
```

This injects failed requests, lost responses, and an outage. It checks that retry
and resume recover all uploads, the downloads match byte for byte, and quota is
counted once. It can take several minutes because it exercises real backoff.
The seed replays the upload request faults; the bot's storage faults are random.

Afterwards, restore your previous `BLOB_STORE`, restart `pnpm dev`, and remove the test
credentials from the terminal environment:

```powershell
Remove-Item Env:DFS_PASSWORD, Env:DFS_USERNAME, Env:DFS_API, Env:DFS_ORIGIN, Env:DFS_CHAOS_SEED -ErrorAction SilentlyContinue
```

If you test a database restart, the bot exits after losing its leadership lock
by design. Restart `pnpm dev` after PostgreSQL is available again.

## Measure performance

Run the browser bookkeeping and upload scheduler benchmarks without a server:

```powershell
pnpm --filter @dfs/web check:performance
```

The queue benchmark compares four progress updates in queues of 10,000 and
100,000 files. The scheduler benchmark checks SHA-256, part counts and request
limits while comparing preparation in request slots with bounded preparation
ahead. Its 30 ms request latency is synthetic; it measures neither API nor
storage throughput. It compares four, six and eight parallel parts without
changing the application's defaults.

Run the native encryption and durable disk benchmark separately:

```powershell
pnpm --filter @dfs/api check:performance
```

It uses a temporary directory and no database or account. Each scenario reports
elapsed time, throughput, CPU time, sampled peak process memory and maximum
event-loop delay. It compares encryption alone, sequential writes and hashing,
unrestricted overlap, and the application's load-aware overlap policy at one,
four and eight concurrent parts. It tests 1 KiB, 1 MiB and 10 MiB parts.

To compare native thread-pool sizes, set the variable before starting each Node
process and restore your previous setting afterwards:

```powershell
$previousThreadPoolSize = $env:UV_THREADPOOL_SIZE
try {
  foreach ($threads in 4, 8, 16) {
    $env:UV_THREADPOOL_SIZE = [string]$threads
    pnpm --filter @dfs/api check:performance
    if ($LASTEXITCODE -ne 0) { throw 'Performance check failed.' }
  }
} finally {
  $env:UV_THREADPOOL_SIZE = $previousThreadPoolSize
}
```

Run benchmarks when other checks are idle, repeat them, and compare the live
end-to-end phases too. Higher concurrency can consume more memory and compete
with filesystem and crypto work. Validate tuning on the target server and
network before changing defaults. Browser profiling should use the production
build and include scrolling a large upload queue, pause/resume, and an outage.
