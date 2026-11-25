import { describe, expect, it } from 'vitest'
import { agentNote } from './agent-note'

const base = {
  origin: 'https://dfs.example',
  folderName: 'Notes',
  canWrite: true,
  token: 'dfs_app_x',
}

describe('agentNote', () => {
  it('says read and write, the token and the guide', () => {
    expect(agentNote(base)).toBe(
      [
        'Use my DFS at https://dfs.example, folder "Notes", read and write.',
        'Token: dfs_app_x  (send as: Authorization: Bearer <token>)',
        'Read https://dfs.example/api/v1/guide first.',
      ].join('\n'),
    )
  })

  it('says read only', () => {
    expect(agentNote({ ...base, canWrite: false }).split('\n')[0]).toBe(
      'Use my DFS at https://dfs.example, folder "Notes", read only.',
    )
  })

  it('writes a quote in the folder name as it is', () => {
    expect(agentNote({ ...base, folderName: 'My "best" notes' }).split('\n')[0]).toBe(
      'Use my DFS at https://dfs.example, folder "My "best" notes", read and write.',
    )
  })
})
