import { describeUserAgent } from '@/lib/user-agent'

/**
 * The program a device last used its token from, such as "DFS Backup" for
 * "DFS Backup/1.0 (Windows 11)". A session's `describeUserAgent` keeps the
 * first word of a script, which would cut a program's name short; a browser
 * (someone using the token by hand) is described the same way as a session.
 */
export function describeDeviceAgent(agent: string): string {
  if (agent.startsWith('Mozilla/')) return describeUserAgent(agent)
  const [product = ''] = agent.split('/')
  return product.trim() === '' ? describeUserAgent(agent) : product.trim()
}
