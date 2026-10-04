import { passwordSchema } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { generatePassword } from './password'

describe('generatePassword', () => {
  it('makes four groups of four unambiguous characters', () => {
    expect(generatePassword()).toMatch(/^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){3}$/)
  })

  it('makes a password the API accepts', () => {
    expect(passwordSchema.safeParse(generatePassword()).success).toBe(true)
  })

  it('doesn’t repeat itself', () => {
    const passwords = new Set(Array.from({ length: 50 }, generatePassword))
    expect(passwords.size).toBe(50)
  })
})
