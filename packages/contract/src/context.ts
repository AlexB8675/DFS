import { adminUserSchema, sessionSchema, type AdminUser } from '@dfs/shared'
import { ApiClient } from './client.ts'
import type { ContractTarget, TestApi } from './target.ts'

/** The runner's test functions plus helpers every part of the suite uses. */
export interface SuiteContext extends TestApi {
  target: () => ContractTarget
  /** A client signed in as the owner. */
  owner: () => Promise<ApiClient>
  /** A fresh account with a temporary password, made by `admin`. */
  newUser: (
    admin: ApiClient,
    role?: 'user' | 'admin',
  ) => Promise<{ user: AdminUser; username: string; temporaryPassword: string }>
  /** Signs in as `username` and chooses `chosenPassword(username)`, as a first sign-in does. */
  activated: (username: string, temporaryPassword: string) => Promise<ApiClient>
  /** A client signed in as `username`. */
  signIn: (username: string, password: string) => Promise<ApiClient>
}

/** The password `activated` chooses for a user, so a test can sign in as them again. */
export function chosenPassword(username: string): string {
  return `chosen-${username}-password`
}

export function createContext(t: TestApi, target: () => ContractTarget): SuiteContext {
  return {
    ...t,
    target,
    owner: async () => {
      const { baseUrl, origin, owner } = target()
      const client = new ApiClient(baseUrl, origin)
      await client.signIn(owner.username, owner.password)
      return client
    },
    newUser: async (admin, role = 'user') => {
      const username = `user-${crypto.randomUUID().slice(0, 8)}`
      const temporaryPassword = `temp-${crypto.randomUUID()}`
      const user = await admin.call('POST', '/admin/users', adminUserSchema, {
        json: { username, temporaryPassword, role },
      })
      return { user, username, temporaryPassword }
    },
    activated: async (username, temporaryPassword) => {
      const { baseUrl, origin } = target()
      const client = new ApiClient(baseUrl, origin)
      await client.signIn(username, temporaryPassword)
      await client.call('POST', '/auth/password', sessionSchema, {
        json: { newPassword: chosenPassword(username) },
      })
      return client
    },
    signIn: async (username, password) => {
      const { baseUrl, origin } = target()
      const client = new ApiClient(baseUrl, origin)
      await client.signIn(username, password)
      return client
    },
  }
}
