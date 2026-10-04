import { describe, expect, it } from 'vitest'
import { loginSchema, passwordSchema, PASSWORD_MIN_LENGTH, usernameSchema } from './schemas.ts'

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
