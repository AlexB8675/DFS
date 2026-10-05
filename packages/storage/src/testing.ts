import type { RequestData } from '@discordjs/rest'
import type { APIOverwrite, ChannelType } from 'discord-api-types/v10'
import type { DiscordRest, DiscordRoute } from './discord.ts'

export interface FakeChannel {
  id: string
  type: ChannelType
  name: string
  parent_id: string | null
  topic?: string | null
  permission_overwrites: APIOverwrite[]
}

/**
 * A Discord server in memory that answers the REST routes DFS uses, so tests
 * never need a token or touch the real server. Tests only.
 */
export class FakeDiscord implements DiscordRest {
  readonly botId = '100000000000000001'
  readonly guildId = '100000000000000002'
  readonly channels: FakeChannel[] = []
  /** Every request, as `METHOD /route`. */
  readonly requests: string[] = []
  #nextId = 300_000_000_000_000_000n

  addChannel(
    channel: Pick<FakeChannel, 'name' | 'type'> & Partial<Omit<FakeChannel, 'id'>>,
  ): FakeChannel {
    const added: FakeChannel = {
      id: String(this.#nextId++),
      parent_id: null,
      permission_overwrites: [],
      ...channel,
    }
    this.channels.push(added)
    return added
  }

  channel(id: string): FakeChannel {
    const found = this.channels.find((channel) => channel.id === id)
    if (!found) throw new Error(`FakeDiscord: no channel ${id}`)
    return found
  }

  get = (route: DiscordRoute): Promise<unknown> => {
    this.requests.push(`GET ${route}`)
    if (route === '/users/@me') return answer({ id: this.botId, username: 'dfs', bot: true })
    if (route === `/guilds/${this.guildId}/channels`) return answer(this.channels)
    throw new Error(`FakeDiscord: no route GET ${route}`)
  }

  post = (route: DiscordRoute, options?: RequestData): Promise<unknown> => {
    this.requests.push(`POST ${route}`)
    if (route === `/guilds/${this.guildId}/channels`) {
      const body = options?.body as Parameters<FakeDiscord['addChannel']>[0]
      return answer(this.addChannel(body))
    }
    throw new Error(`FakeDiscord: no route POST ${route}`)
  }

  put = (route: DiscordRoute, options?: RequestData): Promise<unknown> => {
    this.requests.push(`PUT ${route}`)
    const permission = /^\/channels\/(\d+)\/permissions\/(\d+)$/.exec(route)
    if (permission?.[1] && permission[2]) {
      const channel = this.channel(permission[1])
      const id = permission[2]
      const overwrite = { id, ...(options?.body as Omit<APIOverwrite, 'id'>) }
      channel.permission_overwrites = [
        ...channel.permission_overwrites.filter((existing) => existing.id !== id),
        overwrite,
      ]
      return answer(undefined)
    }
    throw new Error(`FakeDiscord: no route PUT ${route}`)
  }
}

/** Answers with a copy, as the network would, so callers can't alias the fake's state. */
function answer(value: unknown): Promise<unknown> {
  return Promise.resolve(value === undefined ? undefined : structuredClone(value))
}
