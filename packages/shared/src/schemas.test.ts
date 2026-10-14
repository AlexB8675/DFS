import { describe, expect, it } from 'vitest'
import {
  changeVaultCodeSchema,
  loginSchema,
  passwordSchema,
  PASSWORD_MIN_LENGTH,
  unlockVaultSchema,
  usernameSchema,
  vaultCodeSchema,
  vaultStateSchema,
} from './schemas.ts'

describe('usernameSchema', () => {
  it('stores usernames lowercase and trimmed', () => {
    expect(usernameSchema.parse('  Sam.Rivera ')).toBe('sam.rivera')
  })

  it.each(['ab', '.sam', 'sam rivera', 'sam@home', 'x'.repeat(33)])('rejects %j', (name) => {
    expect(usernameSchema.safeParse(name).success).toBe(false)
  })
})

describe('passwordSchema', () => {
  it('only checks the length', () => {
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH)).success).toBe(true)
    expect(passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1)).success).toBe(false)
  })
})

describe('loginSchema', () => {
  it('matches usernames without regard to case', () => {
    expect(loginSchema.parse({ username: ' SAM ', password: 'x' }).username).toBe('sam')
  })
})

describe('the vault (§7.7)', () => {
  it('wants a chosen code of at least six characters, so a six-digit PIN will do', () => {
    expect(vaultCodeSchema.safeParse('12345').success).toBe(false)
    expect(vaultCodeSchema.safeParse('123456').success).toBe(true)
  })

  it('takes a short typed code as wrong, not as malformed', () => {
    expect(unlockVaultSchema.safeParse({ code: '1' }).success).toBe(true)
  })

  it('changes the code with the current one or with the recovery key', () => {
    expect(changeVaultCodeSchema.safeParse({ currentCode: 'x', newCode: '123456' }).success).toBe(
      true,
    )
    expect(
      changeVaultCodeSchema.safeParse({ recoveryKey: 'ABCD-EFGH-JKLM', newCode: '123456' }).success,
    ).toBe(true)
    expect(changeVaultCodeSchema.safeParse({ newCode: '123456' }).success).toBe(false)
    expect(changeVaultCodeSchema.safeParse({ currentCode: 'x', newCode: '123' }).success).toBe(
      false,
    )
  })

  it('describes a vault that does not exist yet', () => {
    expect(
      vaultStateSchema.safeParse({
        exists: false,
        open: false,
        locksAt: null,
        resetAt: null,
        sizeBytes: 0,
        fileCount: 0,
      }).success,
    ).toBe(true)
  })
})
