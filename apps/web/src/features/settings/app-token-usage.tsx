import type { AppToken } from '@dfs/shared'
import { describeDeviceAgent } from '@/features/devices/device-agent'
import { formatDateInSentence, formatFullDate } from '@/lib/format'

/**
 * What a token reaches, when it was made and last used, and from where, in
 * lines for a list of tokens. The person's own list and the admin's say it the same way.
 */
export function AppTokenUsage({
  token,
}: {
  token: Pick<
    AppToken,
    | 'folderPath'
    | 'folderAvailable'
    | 'canWrite'
    | 'createdAt'
    | 'lastUsedAt'
    | 'lastAddress'
    | 'lastAgent'
  >
}) {
  const { createdAt, lastUsedAt, lastAddress, lastAgent } = token
  return (
    <>
      <span>
        {token.folderAvailable ? (
          <span className="break-all">{token.folderPath}</span>
        ) : (
          <span className="font-medium text-destructive">Folder unavailable</span>
        )}
        {' · '}
        {token.canWrite ? 'Read and write' : 'Read only'}
      </span>
      <span>
        Made <span title={formatFullDate(createdAt)}>{formatDateInSentence(createdAt)}</span>
      </span>
      {lastUsedAt ? (
        <span>
          Last used{' '}
          <span title={formatFullDate(lastUsedAt)}>{formatDateInSentence(lastUsedAt)}</span>
          {lastAddress && ` from ${lastAddress}`}
          {lastAgent && ` · ${describeDeviceAgent(lastAgent)}`}
        </span>
      ) : (
        <span>Not used yet</span>
      )}
    </>
  )
}
