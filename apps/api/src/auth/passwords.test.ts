import { describe, expect, it } from 'vitest'
import { COMMON_PASSWORDS } from './common-passwords.ts'
import { hashPassword, passwordProblem } from './passwords.ts'

describe('password rules (§7.1)', () => {
  it('refuses common passwords from the SecLists list, ignoring case', async () => {
    expect(COMMON_PASSWORDS.size).toBeGreaterThan(29_000)
    for (const password of ['Q1W2E3R4T5Y6', 'correcthorsebatterystaple']) {
      expect(await passwordProblem(password, 'someone', null)).toBe(
        'That password is too common. Choose another.',
      )
    }
  })

  it('takes an uncommon password, but not the username or the current one', async () => {
    expect(await passwordProblem('violet tram under the bridge', 'someone', null)).toBeNull()
    expect(await passwordProblem('Someone-Else', 'someone-else', null)).toBe(
      'A password can’t be the username.',
    )
    const current = await hashPassword('violet tram under the bridge')
    expect(await passwordProblem('violet tram under the bridge', 'someone', current)).toBe(
      'That’s the current password. Choose a new one.',
    )
  })
})
