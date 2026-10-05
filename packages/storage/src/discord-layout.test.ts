import { DiscordAPIError } from '@discordjs/rest'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord-api-types/v10'
import { describe, expect, it } from 'vitest'
import {
  adoptChannel,
  channelsInCategory,
  ChannelRefusedError,
  ensureDiscordLayout,
} from './discord-layout.ts'
import { BOT_CHANNEL_PERMISSIONS, discordProblem } from './discord.ts'
import { FakeDiscord } from './testing.ts'

const NAMES = [
  'storage-00',
  'storage-01',
  'storage-02',
  'storage-03',
  'dfs-journal',
  'dfs-backups',
  'dfs-log',
]

function privateOverwrites(discord: FakeDiscord) {
  return expect.arrayContaining([
    {
      id: discord.botId,
      type: OverwriteType.Member,
      allow: String(BOT_CHANNEL_PERMISSIONS),
      deny: '0',
    },
    {
      id: discord.guildId,
      type: OverwriteType.Role,
      allow: '0',
      deny: String(PermissionFlagsBits.ViewChannel),
    },
  ]) as unknown
}

describe('ensureDiscordLayout (DESIGN.md §4)', () => {
  it('creates the category and its channels, hidden from everyone but the bot', async () => {
    const discord = new FakeDiscord()
    const layout = await ensureDiscordLayout(discord, discord.guildId, 'DFS Dev')

    const category = discord.channel(layout.categoryId)
    expect(category).toMatchObject({ name: 'DFS Dev', type: ChannelType.GuildCategory })
    expect(category.permission_overwrites).toEqual(privateOverwrites(discord))
    expect(layout.channels.map(({ name, kind }) => [name, kind])).toEqual([
      ['storage-00', 'data'],
      ['storage-01', 'data'],
      ['storage-02', 'data'],
      ['storage-03', 'data'],
      ['dfs-journal', 'journal'],
      ['dfs-backups', 'backup'],
      ['dfs-log', 'log'],
    ])
    for (const { discordChannelId, name } of layout.channels) {
      const channel = discord.channel(discordChannelId)
      expect(channel).toMatchObject({ name, type: ChannelType.GuildText, parent_id: category.id })
      expect(channel.permission_overwrites).toEqual(privateOverwrites(discord))
    }
    expect(layout.changes).toEqual([
      'created the category “DFS Dev”',
      ...NAMES.map((name) => `created #${name}`),
    ])
  })

  it('changes nothing when run again', async () => {
    const discord = new FakeDiscord()
    const first = await ensureDiscordLayout(discord, discord.guildId, 'DFS Dev')
    discord.requests.length = 0

    const second = await ensureDiscordLayout(discord, discord.guildId, 'DFS Dev')
    expect(second).toEqual({ ...first, changes: [] })
    expect(discord.requests).toEqual(['GET /users/@me', `GET /guilds/${discord.guildId}/channels`])
  })

  it('keeps to its own category, and hides channels someone made public again', async () => {
    const discord = new FakeDiscord()
    const production = discord.addChannel({ name: 'DFS', type: ChannelType.GuildCategory })
    const theirs = discord.addChannel({
      name: 'storage-00',
      type: ChannelType.GuildText,
      parent_id: production.id,
    })
    const category = discord.addChannel({ name: 'DFS Dev', type: ChannelType.GuildCategory })
    const reactions = PermissionFlagsBits.AddReactions
    const ours = discord.addChannel({
      name: 'storage-00',
      type: ChannelType.GuildText,
      parent_id: category.id,
      permission_overwrites: [
        {
          id: discord.guildId,
          type: OverwriteType.Role,
          allow: String(PermissionFlagsBits.ViewChannel | reactions),
          deny: '0',
        },
      ],
    })
    const before = structuredClone(discord.channels.slice(0, 2))

    const layout = await ensureDiscordLayout(discord, discord.guildId, 'DFS Dev')
    expect(layout.categoryId).toBe(category.id)
    expect(layout.channels[0]?.discordChannelId).toBe(ours.id)
    expect(layout.channels.map(({ discordChannelId }) => discordChannelId)).not.toContain(theirs.id)
    expect(discord.channels.slice(0, 2)).toEqual(before)
    // Its other bits stay; only View Channel goes.
    expect(discord.channel(ours.id).permission_overwrites).toEqual(
      expect.arrayContaining([
        {
          id: discord.guildId,
          type: OverwriteType.Role,
          allow: String(reactions),
          deny: String(PermissionFlagsBits.ViewChannel),
        },
      ]),
    )
    expect(layout.changes).toEqual([
      'let the bot into the category “DFS Dev”',
      'hid the category “DFS Dev” from everyone',
      'let the bot into #storage-00',
      'hid #storage-00 from everyone',
      ...NAMES.slice(1).map((name) => `created #${name}`),
    ])
  })

  it('refuses a layout it would have to guess about', async () => {
    const twice = new FakeDiscord()
    twice.addChannel({ name: 'DFS Dev', type: ChannelType.GuildCategory })
    twice.addChannel({ name: 'DFS Dev', type: ChannelType.GuildCategory })
    await expect(ensureDiscordLayout(twice, twice.guildId, 'DFS Dev')).rejects.toThrow(
      'The server has 2 categories named “DFS Dev”',
    )

    const voice = new FakeDiscord()
    const category = voice.addChannel({ name: 'DFS Dev', type: ChannelType.GuildCategory })
    voice.addChannel({ name: 'storage-01', type: ChannelType.GuildVoice, parent_id: category.id })
    await expect(ensureDiscordLayout(voice, voice.guildId, 'DFS Dev')).rejects.toThrow(
      '“DFS Dev” must hold exactly one text channel named #storage-01',
    )
  })
})

describe('adoptChannel and channelsInCategory (D25)', () => {
  function server() {
    const discord = new FakeDiscord()
    const dev = discord.addChannel({ name: 'DFS Dev', type: ChannelType.GuildCategory })
    const production = discord.addChannel({ name: 'DFS', type: ChannelType.GuildCategory })
    const ours = discord.addChannel({
      name: 'storage-04',
      type: ChannelType.GuildText,
      parent_id: dev.id,
    })
    const theirs = discord.addChannel({
      name: 'storage-00',
      type: ChannelType.GuildText,
      parent_id: production.id,
    })
    const loose = discord.addTextChannel('general')
    const voice = discord.addChannel({
      name: 'talk',
      type: ChannelType.GuildVoice,
      parent_id: dev.id,
    })
    return { discord, ours, theirs, loose, voice }
  }

  it('takes a text channel of this environment’s category, and makes it private', async () => {
    const { discord, ours } = server()
    const adopted = await adoptChannel(discord, discord.guildId, 'DFS Dev', ours.id)
    expect(adopted).toEqual({
      name: 'storage-04',
      changes: ['let the bot into #storage-04', 'hid #storage-04 from everyone'],
    })
    expect(discord.channel(ours.id).permission_overwrites).toEqual(privateOverwrites(discord))
  })

  it('refuses other environments’ channels, loose ones, voice channels and unknown IDs', async () => {
    const { discord, theirs, loose, voice } = server()
    for (const id of [theirs.id, loose.id, voice.id, '100000000000000099']) {
      await expect(adoptChannel(discord, discord.guildId, 'DFS Dev', id)).rejects.toBeInstanceOf(
        ChannelRefusedError,
      )
    }
    await expect(adoptChannel(discord, discord.guildId, 'DFS Dev', theirs.id)).rejects.toThrow(
      'That channel isn’t in the “DFS Dev” category',
    )
    expect(discord.requests.filter((request) => request.startsWith('PUT'))).toEqual([])
  })

  it('lists the channels inside a category only', async () => {
    const { discord, ours, voice } = server()
    expect(await channelsInCategory(discord, discord.guildId, 'DFS Dev')).toEqual(
      new Set([ours.id, voice.id]),
    )
  })
})

describe('discordProblem', () => {
  const refusal = (status: number, code: number, message: string) =>
    new DiscordAPIError({ code, message }, code, status, 'POST', 'https://discord.com/api', {
      body: undefined,
    })

  it('explains the refusals setup can meet, and leaves other errors alone', () => {
    expect(discordProblem(refusal(401, 0, '401: Unauthorized'))).toMatch(/DISCORD_BOT_TOKEN/)
    expect(discordProblem(refusal(404, 10004, 'Unknown Guild'))).toMatch(/DISCORD_GUILD_ID/)
    expect(discordProblem(refusal(403, 50013, 'Missing Permissions'))).toMatch(/Manage Channels/)
    expect(discordProblem(refusal(400, 50035, 'Invalid Form Body'))).toBe(
      'Discord answered 400: Invalid Form Body',
    )
    expect(discordProblem(new Error('socket hang up'))).toBeNull()
  })
})
