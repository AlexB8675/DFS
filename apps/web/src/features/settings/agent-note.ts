interface AgentNoteInput {
  origin: string
  folderName: string
  canWrite: boolean
  token: string
}

/** The note to paste to an AI agent: where DFS is, what it may reach, how to sign in. */
export function agentNote({ origin, folderName, canWrite, token }: AgentNoteInput): string {
  return [
    `Use my DFS at ${origin}, folder "${folderName}", ${canWrite ? 'read and write' : 'read only'}.`,
    `Token: ${token}  (send as: Authorization: Bearer <token>)`,
    `Read ${origin}/api/v1/guide first.`,
  ].join('\n')
}
