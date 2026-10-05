import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig, type Config } from '@dfs/config'
import {
  appendJournal,
  createDatabase,
  createPool,
  userRecord,
  users,
  type Database,
} from '@dfs/db'
import { generatePassword, usernameSchema } from '@dfs/shared'
import { createDiscordRest, discordProblem } from '@dfs/storage'
import { eq } from 'drizzle-orm'
import { audit } from './audit.ts'
import { hashPassword } from './auth/passwords.ts'
import { endUserSessions } from './auth/sessions.ts'
import { setUpDiscord } from './discord-setup.ts'
import { createUser } from './users/users.ts'

// `dfs`: admin commands run on the server (DESIGN.md §4, §7.1).
//
//   pnpm dfs owner [--username <name>]
//   pnpm dfs setup
//
// `owner` creates the owner account with a temporary password, or, when the
// owner exists, gives it a new one and signs it out everywhere: the way back
// in for the owner, since there is no email.
//
// `setup` creates this environment's Discord category and channels where
// missing, and registers them for storage. Development has no slash commands
// (D25), so this is how it gets its channels.

const USAGE = 'Usage: dfs owner [--username <name>] | dfs setup'
const DAY_MS = 24 * 60 * 60_000
const rootDir = path.resolve(import.meta.dirname, '../../..')

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { username: { type: 'string' } },
})

const command = positionals.length === 1 ? positionals[0] : undefined
if (command !== 'owner' && !(command === 'setup' && values.username === undefined)) {
  console.error(`[ERROR] ${USAGE}`)
  process.exit(1)
}

let config: Config
try {
  config = loadConfig(process.env, { service: 'cli', rootDir })
} catch (error) {
  console.error('[ERROR]', error instanceof ConfigError ? error.message : error)
  process.exit(1)
}

const pool = createPool(config.databaseUrl, {
  applicationName: 'dfs-cli',
  onError: () => undefined,
})
try {
  if (command === 'owner') await owner(createDatabase(pool), config, values.username)
  else await setup(createDatabase(pool), config)
} catch (error) {
  console.error(
    '[ERROR]',
    discordProblem(error) ?? (error instanceof Error ? error.message : error),
  )
  process.exitCode = 1
} finally {
  await pool.end()
}

async function owner(
  db: Database,
  config: Config,
  givenUsername: string | undefined,
): Promise<void> {
  const temporaryPassword = generatePassword()
  const passwordHash = await hashPassword(temporaryPassword)
  const passwordExpiresAt = new Date(Date.now() + config.tempPasswordDays * DAY_MS)
  const [existing] = await db.select().from(users).where(eq(users.isOwner, true))

  let username: string
  if (existing) {
    username = existing.username
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(users)
        .set({
          passwordHash,
          passwordExpiresAt,
          disabledAt: null,
          failedSignIns: 0,
          signInLockedUntil: null,
        })
        .where(eq(users.id, existing.id))
        .returning()
      if (!updated) throw new Error('The owner account disappeared.')
      await endUserSessions(tx, existing.id)
      await audit(tx, {
        actorId: null,
        action: 'user.password_reset',
        target: existing.displayName,
        details: 'dfs owner',
      })
      await appendJournal(tx, [userRecord(updated)])
    })
    console.info(
      `[INFO] Gave the owner, ${username}, a new temporary password and signed them out everywhere.`,
    )
  } else {
    username = usernameSchema.parse(
      givenUsername ?? (await ask('Username for the owner account: ')),
    )
    await db.transaction((tx) =>
      createUser(tx, {
        username,
        displayName: username,
        passwordHash,
        passwordExpiresAt,
        role: 'admin',
        quotaBytes: config.defaultQuotaBytes,
        isOwner: true,
      }),
    )
    console.info(`[INFO] Created the owner account, ${username}.`)
  }

  console.info(`[INFO] Sign-in details:
  Sign in at:          ${config.publicBaseUrl}/login
  Username:            ${username}
  Temporary password:  ${temporaryPassword}
  Works until:         ${passwordExpiresAt.toLocaleString()}

You'll choose your own password when you sign in.`)
}

async function setup(db: Database, config: Config): Promise<void> {
  const { botToken, guildId, categoryName } = config.discord
  if (!botToken || !guildId) {
    throw new Error('Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID in the root .env first.')
  }
  const report = await setUpDiscord(db, createDiscordRest(botToken), { guildId, categoryName })
  for (const change of report.changes) console.info(`[INFO] Discord: ${change}.`)
  if (report.registered.length > 0) {
    console.info(`[INFO] Registered for storage: ${report.registered.join(', ')}.`)
  }
  if (report.changes.length === 0 && report.registered.length === 0) {
    console.info(`[INFO] “${categoryName}” and its channels were already set up.`)
  }
}

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`No terminal to ask in. ${USAGE}`)
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await prompt.question(question)
  } finally {
    prompt.close()
  }
}
