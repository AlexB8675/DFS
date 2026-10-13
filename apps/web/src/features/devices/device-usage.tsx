import type { Device } from '@dfs/shared'
import { formatDateInSentence, formatFullDate } from '@/lib/format'
import { describeUserAgent } from '@/lib/user-agent'

/**
 * When a device was paired and last used, and from where (§7.6), in two lines
 * for a list of devices. The person's own list and the admin's say it the same way.
 */
export function DeviceUsage({
  device,
}: {
  device: Pick<Device, 'createdAt' | 'lastUsedAt' | 'lastAddress' | 'lastAgent'>
}) {
  const { createdAt, lastUsedAt, lastAddress, lastAgent } = device
  return (
    <>
      <span>
        Paired <span title={formatFullDate(createdAt)}>{formatDateInSentence(createdAt)}</span>
      </span>
      {lastUsedAt ? (
        <span>
          Last used{' '}
          <span title={formatFullDate(lastUsedAt)}>{formatDateInSentence(lastUsedAt)}</span>
          {lastAddress && ` from ${lastAddress}`}
          {lastAgent && ` · ${describeUserAgent(lastAgent)}`}
        </span>
      ) : (
        <span>Not used yet</span>
      )}
    </>
  )
}
