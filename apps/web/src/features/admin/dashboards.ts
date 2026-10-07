import type { ChartSpec } from './metrics'

// What the admin's graphs show (§16). A thing keeps its colour on every
// graph: what browsers send is 1, what reaches Discord 2, what browsers get
// back 3; the API is 1 and the bot 2; next to Discord, the internet is 1.
// Lines that mean trouble wear status colours, never next to series colours.

const throughput: ChartSpec = {
  title: 'Throughput',
  description: 'Bytes per second: received, stored in Discord, and sent back.',
  format: 'bytesPerSecond',
  lines: [
    { label: 'Received from browsers', color: 1, series: 'uploads.bytes:rate' },
    { label: 'Posted to Discord', color: 2, series: 'discord.posted:rate' },
    { label: 'Sent to browsers', color: 3, series: 'downloads.bytes:rate' },
  ],
}

const backlog: ChartSpec = {
  title: 'Waiting to sync',
  description: 'Uploaded but not yet in Discord, and the staging disk holding it.',
  format: 'bytes',
  lines: [
    { label: 'Waiting to sync', color: 1, series: 'sync.bytes:avg' },
    { label: 'Staging used', color: 2, series: 'staging.bytes:avg' },
  ],
}

const stored: ChartSpec = {
  title: 'Stored on Discord',
  description: 'Bytes in Discord, and how many of them files still use.',
  format: 'bytes',
  lines: [
    { label: 'Stored', color: 1, series: 'storage.bytes:avg' },
    { label: 'Still used', color: 2, series: 'storage.live_bytes:avg' },
  ],
}

const refused: ChartSpec = {
  title: 'Refused and failed requests',
  description: 'Requests per minute the API refused (4xx) or failed to answer (5xx).',
  format: 'perMinute',
  lines: [
    { label: 'Refused (4xx)', color: 'warning', series: 'http.client_errors:rate' },
    { label: 'Failed (5xx)', color: 'critical', series: 'http.server_errors:rate' },
  ],
}

export const OVERVIEW_CHARTS: ChartSpec[] = [throughput, backlog, stored, refused]

const connections: ChartSpec = {
  title: 'Database connections',
  description: 'Connections to this database, and how many run a query.',
  format: 'count',
  lines: [
    { label: 'Connections', color: 1, series: 'pg.connections:avg' },
    { label: 'Running a query', color: 2, series: 'pg.active:avg' },
  ],
}

const transactions: ChartSpec = {
  title: 'Transactions',
  description: 'Per second: transactions committed, and rolled back.',
  format: 'perSecond',
  lines: [
    { label: 'Commits', color: 1, series: 'pg.commits:rate' },
    { label: 'Rollbacks', color: 2, series: 'pg.rollbacks:rate' },
  ],
}

const bufferHits: ChartSpec = {
  title: 'Buffer cache hit rate',
  description: 'Blocks found in PostgreSQL’s memory, of all it read.',
  format: 'percent',
  lines: [
    {
      label: 'Hit rate',
      color: 1,
      share: 'pg.cache_hits:rate',
      of: ['pg.cache_hits:rate', 'pg.disk_reads:rate'],
    },
  ],
}

const databaseSize: ChartSpec = {
  title: 'Database size',
  description: 'The size of the PostgreSQL database on disk.',
  format: 'bytes',
  lines: [{ label: 'Size', color: 1, series: 'db.bytes:avg' }],
}

/** Admin → Database: PostgreSQL over time (§16). */
export const DATABASE_CHARTS: ChartSpec[] = [
  connections,
  transactions,
  bufferHits,
  {
    title: 'Rows read',
    description: 'Per second, by scans and index lookups.',
    format: 'perSecond',
    lines: [{ label: 'Read', color: 1, series: 'pg.rows_read:rate' }],
  },
  {
    title: 'Rows written',
    description: 'Per second: inserted, updated and deleted.',
    format: 'perSecond',
    lines: [{ label: 'Written', color: 2, series: 'pg.rows_written:rate' }],
  },
  {
    title: 'Written to disk',
    description: 'Bytes per second of write-ahead log, and of temporary files for big sorts.',
    format: 'bytesPerSecond',
    lines: [
      { label: 'WAL', color: 1, series: 'pg.wal_bytes:rate' },
      { label: 'Temporary files', color: 2, series: 'pg.temp_bytes:rate' },
    ],
  },
  {
    title: 'Longest transaction',
    description: 'The oldest open transaction at each sample; long ones hold back vacuum.',
    format: 'ms',
    lines: [{ label: 'Longest', color: 1, series: 'pg.oldest_xact_ms:max' }],
  },
  {
    title: 'Lock waits',
    description: 'Queries waiting for another’s lock, at most at each sample.',
    format: 'count',
    lines: [{ label: 'Waiting', color: 'warning', series: 'pg.lock_waits:max' }],
  },
  {
    title: 'Deadlocks',
    description: 'Per minute: deadlocks PostgreSQL broke by failing a transaction.',
    format: 'perMinute',
    lines: [{ label: 'Deadlocks', color: 'critical', series: 'pg.deadlocks:rate' }],
  },
  {
    title: 'Dead rows',
    description: 'Old row versions waiting for vacuum, in all tables.',
    format: 'count',
    lines: [{ label: 'Dead rows', color: 1, series: 'pg.dead_rows:avg' }],
  },
  databaseSize,
]

export interface DashboardSection {
  title: string
  description: string
  charts: ChartSpec[]
}

export const MONITORING_SECTIONS: DashboardSection[] = [
  {
    title: 'Traffic',
    description: 'What the API answers, and how quickly.',
    charts: [
      {
        title: 'Requests',
        description: 'Requests per second, health checks left out.',
        format: 'perSecond',
        lines: [{ label: 'Requests', color: 1, series: 'http.requests:rate' }],
      },
      {
        title: 'Response time',
        description:
          'How long answers take, with the API’s own check every 10 s; downloads and uploads aren’t timed.',
        format: 'ms',
        lines: [
          { label: 'Median', color: 1, series: 'http.ms:p50' },
          { label: '95th percentile', color: 2, series: 'http.ms:p95' },
          { label: '99th percentile', color: 3, series: 'http.ms:p99' },
        ],
      },
      refused,
      {
        title: 'Bandwidth',
        description: 'Bytes per second to and from browsers.',
        format: 'bytesPerSecond',
        lines: [
          { label: 'Received from browsers', color: 1, series: 'uploads.bytes:rate' },
          { label: 'Sent to browsers', color: 3, series: 'downloads.bytes:rate' },
        ],
      },
      {
        title: 'Live connections',
        description: 'Browsers listening for changes.',
        format: 'count',
        lines: [{ label: 'Open event streams', color: 1, series: 'events.streams:avg' }],
      },
    ],
  },
  {
    title: 'Network',
    description:
      'How quickly Discord and the internet answer the API, which checks them every 10 s.',
    charts: [
      {
        title: 'Answer time',
        description: 'The median check: a new connection, then a request answered.',
        format: 'ms',
        lines: [
          { label: 'Discord', color: 2, series: 'check.discord.ms:p50' },
          { label: 'Internet', color: 1, series: 'check.internet.ms:p50' },
        ],
      },
      {
        title: 'Failed checks',
        description: 'Per minute: checks with no answer in 5 s, or a server error.',
        format: 'perMinute',
        lines: [
          { label: 'Discord', color: 'critical', series: 'check.discord.failures:rate' },
          { label: 'Internet', color: 'serious', series: 'check.internet.failures:rate' },
        ],
      },
    ],
  },
  {
    title: 'Discord',
    description: 'What the bot asks of Discord, and how Discord answers.',
    charts: [
      {
        title: 'Discord requests',
        description: 'Requests per second, from storing, deleting, signing and checking.',
        format: 'perSecond',
        lines: [{ label: 'Requests', color: 1, series: 'discord.requests:rate' }],
      },
      {
        title: 'Rate limits',
        description: 'Per minute: waits to stay inside Discord’s limits, and 429 answers.',
        format: 'perMinute',
        lines: [
          { label: 'Waits', color: 1, series: 'discord.waits:events' },
          { label: '429 answers', color: 2, series: 'discord.429:rate' },
        ],
      },
      {
        title: 'Posted to Discord',
        description: 'Bytes per second stored as attachments.',
        format: 'bytesPerSecond',
        lines: [{ label: 'Posted', color: 2, series: 'discord.posted:rate' }],
      },
      {
        title: 'Storage work',
        description:
          'Per minute: blobs stored, messages deleted, packs sealed, and packs that held little merged.',
        format: 'perMinute',
        lines: [
          { label: 'Blobs stored', color: 1, series: 'discord.posted:events' },
          { label: 'Messages deleted', color: 2, series: 'discord.deleted:rate' },
          { label: 'Packs sealed', color: 3, series: 'packs.sealed:rate' },
          { label: 'Packs merged', color: 4, series: 'packs.compacted:rate' },
        ],
      },
      {
        title: 'Discord failures',
        description: 'Per minute: posts that failed (and will be retried), and Discord errors.',
        format: 'perMinute',
        lines: [
          { label: 'Failed posts', color: 'serious', series: 'discord.post_failures:rate' },
          {
            label: 'Discord errors (5xx)',
            color: 'critical',
            series: 'discord.server_errors:rate',
          },
        ],
      },
      {
        title: 'Signed URLs',
        description: 'CDN links signed per minute, for reading files back.',
        format: 'perMinute',
        lines: [{ label: 'Signed', color: 1, series: 'discord.signed:rate' }],
      },
    ],
  },
  {
    title: 'Reading back',
    description: 'Files read from Discord’s CDN, and the frame cache that saves those reads.',
    charts: [
      {
        title: 'Cache hit rate',
        description: 'Frames found in the cache, of all frames read from Discord storage.',
        format: 'percent',
        lines: [
          {
            label: 'Hit rate',
            color: 1,
            share: 'cache.hits:rate',
            of: ['cache.hits:rate', 'cache.misses:rate'],
          },
        ],
      },
      {
        title: 'Read from the CDN',
        description: 'Bytes per second fetched from Discord’s CDN.',
        format: 'bytesPerSecond',
        lines: [{ label: 'Read', color: 3, series: 'cdn.reads:rate' }],
      },
      {
        title: 'Frame cache size',
        description: 'Frames kept on the API’s disk.',
        format: 'bytes',
        lines: [{ label: 'Cached', color: 1, series: 'cache.bytes:avg' }],
      },
      {
        title: 'Failed CDN reads',
        description: 'Per minute: reads from the CDN that failed.',
        format: 'perMinute',
        lines: [{ label: 'Failed reads', color: 'critical', series: 'cdn.failures:rate' }],
      },
    ],
  },
  {
    title: 'Storage',
    description: 'What is in Discord, and what waits to go in or out.',
    charts: [
      stored,
      {
        title: 'Blobs',
        description: 'Attachments in Discord, and how many of them are packs of small files.',
        format: 'count',
        lines: [
          { label: 'Stored blobs', color: 1, series: 'storage.blobs:avg' },
          { label: 'Packs', color: 2, series: 'storage.packs:avg' },
        ],
      },
      {
        title: 'Queues',
        description: 'Blobs waiting to be stored or deleted, and upload jobs pending.',
        format: 'count',
        lines: [
          { label: 'Waiting to be stored', color: 1, series: 'blobs.waiting:avg' },
          { label: 'Waiting to be deleted', color: 2, series: 'blobs.deleting:avg' },
          { label: 'Jobs pending', color: 3, series: 'queue.pending:avg' },
        ],
      },
      {
        title: 'Failed uploads',
        description: 'Blobs that gave up being stored in Discord after every try.',
        format: 'count',
        lines: [{ label: 'Failed jobs', color: 'warning', series: 'queue.failed:avg' }],
      },
      backlog,
      {
        title: 'Freed by compaction',
        description:
          'Bytes per second of deleted files that left Discord as packs that held little were merged.',
        format: 'bytesPerSecond',
        lines: [{ label: 'Freed', color: 2, series: 'compaction.freed_bytes:rate' }],
      },
      {
        title: 'Damaged packs',
        description:
          'Per minute: packs compaction found damaged. Their files may not download; the bot’s log says which.',
        format: 'perMinute',
        lines: [{ label: 'Damaged', color: 'critical', series: 'compaction.failures:rate' }],
      },
    ],
  },
  {
    title: 'Database',
    description: 'PostgreSQL at work; Admin → Database has the rest, and what runs now.',
    charts: [connections, transactions, bufferHits, databaseSize],
  },
  {
    title: 'Processes',
    description: 'How hard the API and the bot work.',
    charts: [
      {
        title: 'Memory',
        description: 'Resident memory of each process.',
        format: 'bytes',
        lines: [
          { label: 'API', color: 1, series: 'api.rss:avg' },
          { label: 'Bot', color: 2, series: 'bot.rss:avg' },
        ],
      },
      {
        title: 'CPU',
        description: 'Share of one core each process uses.',
        format: 'percent',
        lines: [
          { label: 'API', color: 1, series: 'api.cpu:avg' },
          { label: 'Bot', color: 2, series: 'bot.cpu:avg' },
        ],
      },
      {
        title: 'Event loop delay',
        description: 'How late each process runs what it has to do (99th percentile).',
        format: 'ms',
        lines: [
          { label: 'API', color: 1, series: 'api.loop_ms:avg' },
          { label: 'Bot', color: 2, series: 'bot.loop_ms:avg' },
        ],
      },
      {
        title: 'Heap',
        description: 'JavaScript memory in use in each process.',
        format: 'bytes',
        lines: [
          { label: 'API', color: 1, series: 'api.heap:avg' },
          { label: 'Bot', color: 2, series: 'bot.heap:avg' },
        ],
      },
    ],
  },
  {
    title: 'People',
    description: 'Accounts, what they keep, and how they sign in.',
    charts: [
      {
        title: 'Files',
        description: 'Files in everyone’s drives.',
        format: 'count',
        lines: [{ label: 'Files', color: 1, series: 'files.count:avg' }],
      },
      {
        title: 'Used space',
        description: 'Bytes counted against quotas, versions and trash included.',
        format: 'bytes',
        lines: [{ label: 'Used', color: 1, series: 'files.bytes:avg' }],
      },
      {
        title: 'Sign-ins',
        description: 'Per minute: sign-ins, and attempts with a wrong password.',
        format: 'perMinute',
        lines: [
          { label: 'Signed in', color: 1, series: 'auth.sign_ins:rate' },
          { label: 'Failed', color: 2, series: 'auth.failed_sign_ins:rate' },
        ],
      },
      {
        title: 'Users and sessions',
        description: 'Accounts, and sessions signed in now.',
        format: 'count',
        lines: [
          { label: 'Users', color: 1, series: 'users.count:avg' },
          { label: 'Sessions', color: 2, series: 'sessions.count:avg' },
        ],
      },
    ],
  },
]
