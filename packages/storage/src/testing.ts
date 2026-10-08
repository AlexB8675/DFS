import { DiscordAPIError, type RawFile, type RequestData } from '@discordjs/rest'
import { ChannelType, type APIOverwrite } from 'discord-api-types/v10'
import type { DiscordRest, DiscordRoute } from './discord.ts'

export interface FakeChannel {
  id: string
  type: ChannelType
  name: string
  parent_id: string | null
  topic?: string | null
  permission_overwrites: APIOverwrite[]
}

export interface FakeMessage {
  id: string
  channel_id: string
  author: { id: string; bot: boolean }
  content: string
  nonce: string | null
  attachments: { id: string; filename: string; size: number; url: string }[]
}

const CDN = 'https://cdn.discordapp.com'
const URL_LIFETIME_MS = 24 * 60 * 60_000
/** Discord's snowflakes count milliseconds from 2015. */
const DISCORD_EPOCH = 1_420_070_400_000n

/**
 * A Discord server in memory that answers the REST routes DFS uses, with a
 * CDN behind it (`fetch`), so tests never need a token or touch the real
 * server. It behaves as Discord was found to: a repeated nonce returns the
 * first message, the CDN honours Range requests, and messages after an ID
 * come oldest first but listed newest first. A deleted message's attachment
 * can still be signed, but the CDN serves it only through a link that served
 * it before the deletion (its cache); one never read is gone at once. IDs
 * are snowflakes of the moment they were made. Tests only.
 */
export class FakeDiscord implements DiscordRest {
  readonly botId = '100000000000000001'
  readonly guildId = '100000000000000002'
  readonly channels: FakeChannel[] = []
  readonly messages: FakeMessage[] = []
  /** Attachment bytes by unsigned URL; remove one to make it gone from the CDN. */
  readonly cdn = new Map<string, Uint8Array>()
  /** Every request, as `METHOD /route`. */
  readonly requests: string[] = []
  /** Requests the CDN has answered. */
  cdnRequests = 0
  /**
   * The CDN holds its answers from this request on (counting from 1, as
   * `cdnRequests` does) until `releaseCdn`; one whose signal aborts
   * meanwhile rejects with its reason, and counts in `cdnAborted`.
   */
  holdCdnFrom = Infinity
  cdnAborted = 0
  /** Stores the next message, then fails as if its answer were lost. */
  loseNextAnswer = false
  /** Keeps one byte less of the next attachment. */
  truncateNextAttachment = false
  /** Has the CDN answer 200 with the whole file instead of honouring Range. */
  ignoreRange = false
  /** The time new IDs are made at; set it to make messages from the past. */
  clock: () => number = () => Date.now()
  readonly #signed = new Set<string>()
  /** Signed links that served an attachment: the CDN's cache. */
  readonly #served = new Set<string>()
  /** Attachments of deleted messages, by unsigned URL. */
  readonly #deleted = new Set<string>()
  #held = Promise.withResolvers<undefined>()
  #sequence = 0n

  addChannel(
    channel: Pick<FakeChannel, 'name' | 'type'> & Partial<Omit<FakeChannel, 'id'>>,
  ): FakeChannel {
    const added: FakeChannel = {
      id: this.#id(),
      parent_id: null,
      permission_overwrites: [],
      ...channel,
    }
    this.channels.push(added)
    return added
  }

  /** A text channel, in the category `parentId` if given. */
  addTextChannel(name: string, parentId: string | null = null): FakeChannel {
    return this.addChannel({ name, type: ChannelType.GuildText, parent_id: parentId })
  }

  addCategory(name: string): FakeChannel {
    return this.addChannel({ name, type: ChannelType.GuildCategory })
  }

  channel(id: string): FakeChannel {
    const found = this.channels.find((channel) => channel.id === id)
    if (!found) throw new Error(`FakeDiscord: no channel ${id}`)
    return found
  }

  /** Adds a message as someone else, or as the bot from another database. */
  addMessage(channelId: string, content: string, authorId = this.botId): FakeMessage {
    const message: FakeMessage = {
      id: this.#id(),
      channel_id: channelId,
      author: { id: authorId, bot: authorId === this.botId },
      content,
      nonce: null,
      attachments: [],
    }
    this.messages.push(message)
    return message
  }

  /** Makes every URL signed so far stop working, as expiry would. */
  revokeUrls(): void {
    this.#signed.clear()
  }

  /** Lets the CDN answer what it holds (`holdCdnFrom`). */
  releaseCdn(): void {
    this.#held.resolve(undefined)
    this.#held = Promise.withResolvers<undefined>()
  }

  get = (route: DiscordRoute, options?: RequestData): Promise<unknown> => {
    this.requests.push(`GET ${route}`)
    if (route === '/users/@me') return answer({ id: this.botId, username: 'dfs', bot: true })
    if (route === `/guilds/${this.guildId}/channels`) return answer(this.channels)
    const single = /^\/channels\/(\d+)$/.exec(route)
    if (single) {
      const channel = this.channels.find((found) => found.id === single[1])
      if (!channel) return refuse(404, 10003, 'Unknown Channel', 'GET', route)
      return answer({ ...channel, guild_id: this.guildId })
    }
    const listing = /^\/channels\/(\d+)\/messages$/.exec(route)
    if (listing) {
      if (!this.channels.some((channel) => channel.id === listing[1])) {
        return refuse(404, 10003, 'Unknown Channel', 'GET', route)
      }
      const after = BigInt(options?.query?.get('after') ?? '0')
      const limit = Number(options?.query?.get('limit') ?? '50')
      const page = this.messages
        .filter((message) => message.channel_id === listing[1] && BigInt(message.id) > after)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
        .slice(0, limit)
        .reverse()
      return answer(page.map((message) => this.#withUrls(message)))
    }
    throw new Error(`FakeDiscord: no route GET ${route}`)
  }

  post = (route: DiscordRoute, options?: RequestData): Promise<unknown> => {
    this.requests.push(`POST ${route}`)
    if (route === `/guilds/${this.guildId}/channels`) {
      const body = options?.body as Parameters<FakeDiscord['addChannel']>[0]
      return answer(this.addChannel(body))
    }
    const posting = /^\/channels\/(\d+)\/messages$/.exec(route)
    if (posting?.[1]) return this.#postMessage(posting[1], options)
    if (route === '/attachments/refresh-urls') {
      const { attachment_urls: urls } = options?.body as { attachment_urls: string[] }
      return answer({
        refreshed_urls: urls
          .filter((url) => this.cdn.has(url))
          .map((url) => ({ original: url, refreshed: this.#sign(url) })),
      })
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

  delete = (route: DiscordRoute): Promise<unknown> => {
    this.requests.push(`DELETE ${route}`)
    const whole = /^\/channels\/(\d+)$/.exec(route)
    if (whole) {
      // A channel goes with every message in it.
      const index = this.channels.findIndex((found) => found.id === whole[1])
      if (index < 0) return refuse(404, 10003, 'Unknown Channel', 'DELETE', route)
      this.channels.splice(index, 1)
      for (let at = this.messages.length - 1; at >= 0; at -= 1) {
        const gone = this.messages[at]
        if (!gone || gone.channel_id !== whole[1]) continue
        for (const attachment of gone.attachments) this.#deleted.add(attachment.url)
        this.messages.splice(at, 1)
      }
      return answer(undefined)
    }
    const message = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route)
    if (message) {
      const index = this.messages.findIndex(
        (found) => found.channel_id === message[1] && found.id === message[2],
      )
      if (index < 0) return refuse(404, 10008, 'Unknown Message', 'DELETE', route)
      for (const attachment of this.messages[index]?.attachments ?? []) {
        this.#deleted.add(attachment.url)
      }
      this.messages.splice(index, 1)
      return answer(undefined)
    }
    throw new Error(`FakeDiscord: no route DELETE ${route}`)
  }

  /** The CDN: serves attachments by signed URL, with Range requests. */
  fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    this.cdnRequests += 1
    const signal = init?.signal
    if (this.cdnRequests >= this.holdCdnFrom) {
      const held = this.#held.promise
      return new Promise((resolve, reject) => {
        const giveUp = () => {
          this.cdnAborted += 1
          reject(signal?.reason as Error)
        }
        if (signal?.aborted) {
          giveUp()
          return
        }
        signal?.addEventListener('abort', giveUp, { once: true })
        void held.then(() => {
          signal?.removeEventListener('abort', giveUp)
          resolve(this.#answer(input, init))
        })
      })
    }
    return this.#answer(input, init)
  }

  #answer(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input)
    const data = this.cdn.get(`${url.origin}${url.pathname}`)
    if (!data) return Promise.resolve(new Response('Not found', { status: 404 }))
    const gone =
      !this.#signed.has(url.href) ||
      (this.#deleted.has(`${url.origin}${url.pathname}`) && !this.#served.has(url.href))
    if (gone) {
      return Promise.resolve(new Response('This content is no longer available.', { status: 404 }))
    }
    this.#served.add(url.href)
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')
    if (!range || this.ignoreRange) return Promise.resolve(new Response(data.slice()))
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), data.length - 1)
    return Promise.resolve(
      new Response(data.slice(start, end + 1), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${String(start)}-${String(end)}/${String(data.length)}`,
        },
      }),
    )
  }

  #postMessage(channelId: string, options: RequestData | undefined): Promise<unknown> {
    if (!this.channels.some((channel) => channel.id === channelId)) {
      return refuse(404, 10003, 'Unknown Channel', 'POST', `/channels/${channelId}/messages`)
    }
    const body = options?.body as { content: string; nonce?: string; enforce_nonce?: boolean }
    const repeated = this.messages.find(
      (message) =>
        body.enforce_nonce && message.channel_id === channelId && message.nonce === body.nonce,
    )
    if (repeated) return answer(this.#withUrls(repeated))
    const message: FakeMessage = {
      id: this.#id(),
      channel_id: channelId,
      author: { id: this.botId, bot: true },
      content: body.content,
      nonce: body.nonce ?? null,
      attachments: (options?.files ?? []).map((file: RawFile) => {
        let data = new Uint8Array(file.data as Uint8Array)
        if (this.truncateNextAttachment) {
          this.truncateNextAttachment = false
          data = data.slice(0, -1)
        }
        const id = this.#id()
        const url = `${CDN}/attachments/${channelId}/${id}/${file.name}`
        this.cdn.set(url, data)
        return { id, filename: file.name, size: data.length, url }
      }),
    }
    this.messages.push(message)
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false
      return Promise.reject(new Error('FakeDiscord: the answer was lost'))
    }
    return answer(this.#withUrls(message))
  }

  #withUrls(message: FakeMessage): FakeMessage {
    return {
      ...message,
      attachments: message.attachments.map((attachment) => ({
        ...attachment,
        url: this.#sign(attachment.url),
      })),
    }
  }

  #sign(unsigned: string): string {
    const expires = Math.floor((Date.now() + URL_LIFETIME_MS) / 1000).toString(16)
    const signed = `${unsigned}?ex=${expires}&is=0&hm=${this.#id()}&`
    this.#signed.add(signed)
    return signed
  }

  #id(): string {
    const sequence = this.#sequence++ % 4096n
    return String(((BigInt(this.clock()) - DISCORD_EPOCH) << 22n) | sequence)
  }
}

/** Answers with a copy, as the network would, so callers can't alias the fake's state. */
function answer(value: unknown): Promise<unknown> {
  return Promise.resolve(value === undefined ? undefined : structuredClone(value))
}

function refuse(
  status: number,
  code: number,
  message: string,
  method: string,
  route: string,
): Promise<never> {
  return Promise.reject(
    new DiscordAPIError(
      { code, message },
      code,
      status,
      method,
      `https://discord.com/api${route}`,
      {
        body: undefined,
        files: undefined,
      },
    ),
  )
}
