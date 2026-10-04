import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { COMMON_PASSWORDS } from './common-passwords.ts'

// Password hashing (DESIGN.md §7.1): argon2id with OWASP's baseline
// parameters, from Node's own crypto, stored as a PHC string such as
// `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. Hashing runs on the thread
// pool, about 60 ms per password.

const hash = promisify(argon2)

const PARAMETERS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 } as const
const SALT_BYTES = 16

/** The PHC string for a new password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const digest = await hash('argon2id', {
    message: normalize(password),
    nonce: salt,
    ...PARAMETERS,
  })
  const { memory, passes, parallelism } = PARAMETERS
  return `$argon2id$v=19$m=${String(memory)},t=${String(passes)},p=${String(parallelism)}$${b64(salt)}$${b64(digest)}`
}

/** Whether `password` matches a PHC string from `hashPassword`, in constant time. */
export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  const parsed = parsePhc(phc)
  if (!parsed) return false
  const digest = await hash('argon2id', {
    message: normalize(password),
    nonce: parsed.salt,
    memory: parsed.memory,
    passes: parsed.passes,
    parallelism: parsed.parallelism,
    tagLength: parsed.digest.length,
  })
  return timingSafeEqual(digest, parsed.digest)
}

let dummy: Promise<string> | null = null

/**
 * A hash to check unknown usernames against, so a sign-in takes as long
 * whether the account exists or not (§7.1).
 */
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(24).toString('base64'))
  return dummy
}

/**
 * The rules beyond length that a new password must meet (§7.1), or `null`.
 * `previousHash` is the password being replaced, which can't be reused.
 */
export async function passwordProblem(
  password: string,
  username: string,
  previousHash: string | null,
): Promise<string | null> {
  const lower = password.toLowerCase()
  if (lower === username) return 'A password can’t be the username.'
  if (COMMON_PASSWORDS.has(lower)) return 'That password is too common. Choose another.'
  if (previousHash && (await verifyPassword(previousHash, password))) {
    return 'That’s the current password. Choose a new one.'
  }
  return null
}

/** The same characters typed on different devices give the same bytes. */
function normalize(password: string): Buffer {
  return Buffer.from(password.normalize('NFC'), 'utf8')
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/=+$/, '')
}

interface Phc {
  memory: number
  passes: number
  parallelism: number
  salt: Buffer
  digest: Buffer
}

function parsePhc(phc: string): Phc | null {
  const match =
    /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc)
  if (!match) return null
  const [, memory, passes, parallelism, salt = '', digest = ''] = match
  return {
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
    salt: Buffer.from(salt, 'base64'),
    digest: Buffer.from(digest, 'base64'),
  }
}
