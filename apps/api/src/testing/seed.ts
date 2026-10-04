import { users, type Database } from '@dfs/db'
import { eq } from 'drizzle-orm'
import { hashPassword } from '../auth/passwords.ts'
import { createUser } from '../users/users.ts'

/** An account that is ready to use: its own password chosen, nothing pending. Tests only. */
export async function seedUser(
  db: Database,
  input: { username: string; password: string; role?: 'admin' | 'user'; isOwner?: boolean },
): Promise<void> {
  const passwordHash = await hashPassword(input.password)
  await db.transaction(async (tx) => {
    const user = await createUser(tx, {
      username: input.username,
      displayName: input.username,
      passwordHash,
      passwordExpiresAt: new Date(),
      role: input.role ?? 'user',
      quotaBytes: 100 * 1024 ** 3,
      isOwner: input.isOwner ?? false,
    })
    await tx
      .update(users)
      .set({ passwordExpiresAt: null, activatedAt: new Date() })
      .where(eq(users.id, user.id))
  })
}
