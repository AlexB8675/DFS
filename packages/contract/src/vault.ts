import { recoveryKeySchema, sessionSchema, vaultCreatedSchema, vaultStateSchema } from '@dfs/shared'
import { chosenPassword, type SuiteContext } from './context.ts'

const RECOVERY_KEY = /^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/

/** The vault (DESIGN.md §7.7): made with a code, opened per session, its recovery key and reset. */
export function vaultTests({
  describe,
  it,
  expect,
  owner,
  newUser,
  activated,
}: SuiteContext): void {
  /** A user who chose their password, signed in, with no vault yet. */
  async function activatedUser() {
    const { username, temporaryPassword } = await newUser(await owner())
    const client = await activated(username, temporaryPassword)
    return { username, client }
  }

  describe('the vault (§7.7)', () => {
    it('makes a vault with a code, open, and shows its recovery key once', async () => {
      const { client } = await activatedUser()
      expect(await client.call('GET', '/vault', vaultStateSchema)).toEqual({
        exists: false,
        open: false,
        locksAt: null,
        resetAt: null,
        sizeBytes: 0,
        fileCount: 0,
      })

      const created = await client.call('POST', '/vault', vaultCreatedSchema, {
        json: { code: '123456' },
      })
      expect(created.recoveryKey).toMatch(RECOVERY_KEY)
      expect(created.vault).toMatchObject({
        exists: true,
        open: true,
        resetAt: null,
        sizeBytes: 0,
        fileCount: 0,
      })
      expect(Date.parse(created.vault.locksAt ?? '')).toBeGreaterThan(Date.now())

      expect(await client.error('POST', '/vault', { json: { code: '123456' } })).toEqual({
        status: 409,
        code: 'vault_exists',
      })

      const other = await activatedUser()
      expect((await other.client.error('POST', '/vault', { json: { code: '12345' } })).status).toBe(
        400,
      )
    })

    it('locks, and opens only with its code', async () => {
      const { client } = await activatedUser()
      await client.call('POST', '/vault', vaultCreatedSchema, { json: { code: '123456' } })

      await client.send('POST', '/vault/lock')
      expect(await client.call('GET', '/vault', vaultStateSchema)).toMatchObject({
        open: false,
        locksAt: null,
      })

      expect(await client.error('POST', '/vault/unlock', { json: { code: '654321' } })).toEqual({
        status: 403,
        code: 'wrong_code',
      })
      expect(
        await client.call('POST', '/vault/unlock', vaultStateSchema, { json: { code: '123456' } }),
      ).toMatchObject({ open: true })

      const other = await activatedUser()
      expect(
        await other.client.error('POST', '/vault/unlock', { json: { code: '123456' } }),
      ).toEqual({ status: 404, code: 'no_vault' })
    })

    it('makes a new recovery key only while open, and the old one stops working', async () => {
      const { client } = await activatedUser()
      const { recoveryKey: first } = await client.call('POST', '/vault', vaultCreatedSchema, {
        json: { code: '123456' },
      })

      await client.send('POST', '/vault/lock')
      expect(await client.error('POST', '/vault/recovery-key')).toEqual({
        status: 403,
        code: 'vault_locked',
      })

      await client.call('POST', '/vault/unlock', vaultStateSchema, { json: { code: '123456' } })
      const { recoveryKey: second } = await client.call(
        'POST',
        '/vault/recovery-key',
        recoveryKeySchema,
      )
      expect(second).toMatch(RECOVERY_KEY)
      expect(second).not.toBe(first)

      expect(
        await client.error('PUT', '/vault/code', {
          json: { recoveryKey: first, newCode: '777777' },
        }),
      ).toEqual({ status: 403, code: 'wrong_recovery_key' })
      expect(
        await client.call('PUT', '/vault/code', vaultStateSchema, {
          json: { recoveryKey: second.toLowerCase().replaceAll('-', ' '), newCode: '777777' },
        }),
      ).toMatchObject({ open: true })

      await client.send('POST', '/vault/lock')
      expect(
        await client.call('POST', '/vault/unlock', vaultStateSchema, { json: { code: '777777' } }),
      ).toMatchObject({ open: true })
      await client.send('POST', '/vault/lock')
      expect(await client.error('POST', '/vault/unlock', { json: { code: '123456' } })).toEqual({
        status: 403,
        code: 'wrong_code',
      })
    })

    it('changes the code with the current one', async () => {
      const { client } = await activatedUser()
      await client.call('POST', '/vault', vaultCreatedSchema, { json: { code: '123456' } })

      expect(
        await client.error('PUT', '/vault/code', {
          json: { currentCode: 'nope-nope', newCode: '888888' },
        }),
      ).toEqual({ status: 403, code: 'wrong_code' })
      expect(
        await client.call('PUT', '/vault/code', vaultStateSchema, {
          json: { currentCode: '123456', newCode: '888888' },
        }),
      ).toMatchObject({ open: true })

      await client.send('POST', '/vault/lock')
      expect(
        await client.call('POST', '/vault/unlock', vaultStateSchema, { json: { code: '888888' } }),
      ).toMatchObject({ open: true })
    })

    it('asks for a reset with the password, says when on the session, and opening cancels it', async () => {
      const { username, client } = await activatedUser()
      await client.call('POST', '/vault', vaultCreatedSchema, { json: { code: '123456' } })

      expect(await client.error('POST', '/vault/reset', { json: { password: 'wrong' } })).toEqual({
        status: 403,
        code: 'wrong_password',
      })
      const asked = await client.call('POST', '/vault/reset', vaultStateSchema, {
        json: { password: chosenPassword(username) },
      })
      expect(asked.resetAt).not.toBeNull()
      const resetAt = Date.parse(asked.resetAt ?? '')
      expect(Math.abs(resetAt - (Date.now() + 7 * 86_400_000)) < 60_000).toBe(true)
      expect((await client.call('GET', '/auth/me', sessionSchema)).vaultResetAt).toBe(asked.resetAt)

      const again = await client.call('POST', '/vault/reset', vaultStateSchema, {
        json: { password: chosenPassword(username) },
      })
      expect(again.resetAt).toBe(asked.resetAt)

      await client.send('POST', '/vault/lock')
      expect(
        await client.call('POST', '/vault/unlock', vaultStateSchema, { json: { code: '123456' } }),
      ).toMatchObject({ resetAt: null })
      expect((await client.call('GET', '/auth/me', sessionSchema)).vaultResetAt).toBeNull()

      const other = await activatedUser()
      expect(
        await other.client.error('POST', '/vault/reset', {
          json: { password: chosenPassword(other.username) },
        }),
      ).toEqual({ status: 404, code: 'no_vault' })
    })
  })
}
