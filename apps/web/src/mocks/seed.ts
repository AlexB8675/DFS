import { splitExtension, type SyncState } from '@dfs/shared'
import type { MockNode, MockShare, MockState } from './db'

// Builds a deterministic demo drive. It deliberately includes the edge cases
// the UI must handle: a folder with 6,000 files, deep nesting, long names, an
// empty folder, every sync state, trashed and moderated items, and share links.

const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.heic': 'image/heic',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flac': 'audio/flac',
  '.m3u': 'audio/x-mpegurl',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.css': 'text/css',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

interface FileOptions {
  /** How long ago the file was last modified. */
  age?: number
  syncState?: SyncState
  syncCompletesAt?: number | null
}

export function createSeed(version: number): MockState {
  const random = mulberry32(20261003)
  const now = Date.now()
  const nodes: Record<string, MockNode> = {}

  const between = (min: number, max: number) => Math.round(min + random() * (max - min))
  const ago = (ms: number) => new Date(now - ms).toISOString()

  function add(fields: Pick<MockNode, 'parentId' | 'kind' | 'name'> & Partial<MockNode>): MockNode {
    const updatedAt = fields.updatedAt ?? ago(between(30, 900) * DAY)
    const node: MockNode = {
      id: makeUuid(random),
      mimeType: null,
      sizeBytes: 0,
      createdAt: updatedAt,
      updatedAt,
      syncState: null,
      syncCompletesAt: null,
      deletedAt: null,
      trashedVia: null,
      moderationReason: null,
      ...fields,
    }
    // Sizes like `4.4 * MB` must still be whole bytes.
    node.sizeBytes = Math.round(node.sizeBytes)
    nodes[node.id] = node
    return node
  }

  const folder = (parentId: string | null, name: string) =>
    add({ parentId, kind: 'folder', name }).id

  const file = (parentId: string, name: string, sizeBytes: number, options: FileOptions = {}) =>
    add({
      parentId,
      kind: 'file',
      name,
      sizeBytes,
      mimeType:
        MIME_TYPES[splitExtension(name).extension.toLowerCase()] ?? 'application/octet-stream',
      syncState: options.syncState ?? 'stored',
      syncCompletesAt: options.syncCompletesAt ?? null,
      ...(options.age === undefined ? {} : { updatedAt: ago(options.age) }),
    }).id

  const folderPath = (parentId: string, names: string[]) =>
    names.reduce((currentId, name) => folder(currentId, name), parentId)

  function photos(parentId: string, count: number, firstNumber: number, newestAge: number) {
    for (let i = 0; i < count; i += 1) {
      const name = `IMG_${String(firstNumber + i).padStart(4, '0')}.jpg`
      file(parentId, name, between(2 * MB, 7 * MB), {
        age: newestAge + (count - i) * 3 * 60 * MINUTE,
      })
    }
  }

  // ── My Drive ──────────────────────────────────────────────────────────────
  const root = folder(null, 'My Drive')
  file(root, 'Welcome to DFS.pdf', 1.4 * MB, { age: 400 * DAY })
  file(root, 'Budget 2026.xlsx', 86 * KB, { age: 25 * MINUTE })
  file(root, 'todo.txt', 2 * KB, { age: 3 * MINUTE })

  // ── Documents ─────────────────────────────────────────────────────────────
  const documents = folder(root, 'Documents')
  const taxes = folder(documents, 'Taxes')
  for (const year of [2023, 2024, 2025]) {
    const yearFolder = folder(taxes, String(year))
    file(yearFolder, 'W-2.pdf', 180 * KB)
    file(yearFolder, '1099-INT.pdf', 95 * KB)
    file(yearFolder, `Tax return ${year}.pdf`, 2.3 * MB)
    file(yearFolder, 'Receipts.zip', between(20, 80) * MB)
  }
  const contracts = folder(documents, 'Contracts')
  file(contracts, 'Lease agreement.pdf', 3.1 * MB)
  file(contracts, 'Employment contract.pdf', 640 * KB)
  file(contracts, 'NDA – Acme Corp.docx', 48 * KB)
  const notes = folder(documents, 'Notes')
  file(notes, 'Meeting notes.md', 12 * KB, { age: 2 * DAY })
  file(notes, 'Ideas.txt', 4 * KB, { age: 20 * 60 * MINUTE })
  file(notes, 'Reading list.md', 3 * KB)
  file(notes, 'Journal 2026.md', 88 * KB, { age: 6 * 60 * MINUTE })
  const resume = file(documents, 'Resume 2026.docx', 120 * KB, { age: 9 * DAY })
  file(documents, 'Cover letter.docx', 64 * KB, { age: 9 * DAY })

  // ── Photos ────────────────────────────────────────────────────────────────
  const photosFolder = folder(root, 'Photos')
  photos(folder(photosFolder, '2023'), 48, 2101, 700 * DAY)
  const photos2024 = folder(photosFolder, '2024')
  const lisbon = folder(photos2024, 'Summer trip – Lisbon')
  photos(lisbon, 64, 4410, 420 * DAY)
  file(lisbon, 'Tram ride.mp4', 340 * MB)
  file(lisbon, 'Sunset at Belém.mov', 512 * MB)
  photos(folder(photos2024, 'Birthday'), 26, 4870, 300 * DAY)
  photos(folder(photosFolder, '2025'), 90, 5200, 60 * DAY)

  // ── Camera Roll: one very large folder ────────────────────────────────────
  const cameraRoll = folder(root, 'Camera Roll')
  const cameraCount = 6000
  for (let i = 1; i <= cameraCount; i += 1) {
    const roll = random()
    const extension = roll < 0.6 ? 'HEIC' : roll < 0.9 ? 'JPG' : 'MOV'
    const size =
      extension === 'MOV'
        ? between(8 * MB, 60 * MB)
        : between(1.5 * MB, extension === 'JPG' ? 6 * MB : 4 * MB)
    const fromNewest = cameraCount - i
    // The newest dozen are still syncing and finish over the first minute.
    const syncing = fromNewest < 12
    file(cameraRoll, `IMG_${String(i).padStart(4, '0')}.${extension}`, size, {
      age: fromNewest * 2 * 60 * MINUTE + between(0, 60) * MINUTE,
      syncState: syncing ? 'syncing' : 'stored',
      syncCompletesAt: syncing ? now + (12 - fromNewest) * 5000 : null,
    })
  }

  // ── Projects, including a very deep path ──────────────────────────────────
  const projects = folder(root, 'Projects')
  const dfs = folder(projects, 'dfs')
  file(dfs, 'README.md', 6 * KB, { age: 50 * MINUTE })
  file(dfs, 'package.json', 1 * KB, { age: 50 * MINUTE })
  file(dfs, 'pnpm-workspace.yaml', 80, { age: 2 * DAY })
  file(folder(dfs, 'docs'), 'DESIGN.md', 64 * KB, { age: 90 * MINUTE })
  const webSrc = folderPath(dfs, ['apps', 'web', 'src'])
  file(webSrc, 'main.tsx', 2 * KB, { age: 40 * MINUTE })
  file(webSrc, 'router.tsx', 3 * KB, { age: 40 * MINUTE })
  const website = folder(projects, 'Personal website')
  file(website, 'index.html', 9 * KB)
  file(website, 'styles.css', 14 * KB)
  const assets = folder(website, 'assets')
  file(assets, 'logo.svg', 4 * KB)
  file(assets, 'hero.webp', 380 * KB)
  const icons = folderPath(projects, [
    'Archive',
    '2019',
    'Clients',
    'Acme Corp',
    'Website redesign',
    'Assets',
    'Images',
    'Icons',
  ])
  for (const name of ['arrow-left', 'arrow-right', 'close', 'menu', 'search', 'user']) {
    file(icons, `icon-${name}.svg`, between(1 * KB, 3 * KB), { age: 2400 * DAY })
  }

  // ── Music ─────────────────────────────────────────────────────────────────
  const music = folder(root, 'Music')
  const albums = folder(music, 'Albums')
  const albumList: [string, string[]][] = [
    [
      'The Paper Lanterns – Harbor Lights (2019)',
      [
        'Low Tide',
        'Harbor Lights',
        'Northbound',
        'Glass',
        'Paper Boats',
        'Lantern Song',
        'Undertow',
        'Last Ferry',
      ],
    ],
    [
      'Mira Sol – Quiet Hours (2022)',
      [
        'Morning',
        'Quiet Hours',
        'Small Talk',
        'Rain on Tin',
        'Static',
        'Window Seat',
        'Afterglow',
        'Night Bus',
        'Home',
      ],
    ],
    [
      'Northern Static – Signals (2024)',
      ['Signal', 'Interference', 'Carrier Wave', 'Drift', 'Frequency', 'Long Range', 'Silence'],
    ],
  ]
  for (const [albumName, tracks] of albumList) {
    const album = folder(albums, albumName)
    tracks.forEach((title, index) => {
      file(
        album,
        `${String(index + 1).padStart(2, '0')} - ${title}.flac`,
        between(18 * MB, 45 * MB),
      )
    })
  }
  const playlists = folder(music, 'Playlists')
  file(playlists, 'Road trip.m3u', 2 * KB)
  file(playlists, 'Focus.m3u', 1 * KB)

  // ── Videos: every sync state ──────────────────────────────────────────────
  const videos = folder(root, 'Videos')
  const wedding = file(videos, 'Wedding highlights.mp4', 4.2 * GB, { age: 200 * DAY })
  file(videos, 'Family dinner.mp4', 1.1 * GB, { age: 33 * DAY })
  file(videos, 'Drone footage – coast.mkv', 11.8 * GB, { age: 40 * MINUTE, syncState: 'syncing' })
  file(videos, 'Old camcorder tape 1998.avi', 2.1 * GB, { age: 500 * DAY, syncState: 'lost' })
  file(videos, 'Screen recording 2026-09-28.mov', 640 * MB, { age: 5 * DAY, syncState: 'failed' })

  // ── Backups ───────────────────────────────────────────────────────────────
  const backups = folder(root, 'Backups')
  file(backups, 'laptop-2026-09-01.tar.gz', 18.4 * GB, { age: 32 * DAY })
  file(backups, 'phone-backup-2026-08.zip', 9.6 * GB, { age: 58 * DAY })
  const dumps = folder(backups, 'Database dumps')
  for (let day = 21; day <= 27; day += 1) {
    file(dumps, `app-2026-09-${day}.sql.gz`, between(300 * MB, 420 * MB), { age: (30 - day) * DAY })
  }

  // ── Edge cases ────────────────────────────────────────────────────────────
  folder(root, 'Scans')
  const longFolder = folder(
    root,
    'A folder with a deliberately long name to check how lists, the tree and breadcrumbs truncate it',
  )
  file(
    longFolder,
    'Another rather long file name that should be truncated with an ellipsis in narrow columns.pdf',
    1.2 * MB,
  )

  // ── Trash ─────────────────────────────────────────────────────────────────
  const drafts = add({
    parentId: root,
    kind: 'folder',
    name: 'Old drafts',
    deletedAt: ago(3 * DAY),
  }).id
  for (const name of [
    'Draft 1.docx',
    'Draft 2.docx',
    'Draft 3 (final).docx',
    'Outline.md',
    'Notes.txt',
  ]) {
    add({
      parentId: drafts,
      kind: 'file',
      name,
      sizeBytes: between(4 * KB, 90 * KB),
      syncState: 'stored',
      trashedVia: drafts,
    })
  }
  add({
    parentId: root,
    kind: 'file',
    name: 'IMG_9999 (copy).jpg',
    sizeBytes: 4.4 * MB,
    mimeType: 'image/jpeg',
    syncState: 'stored',
    deletedAt: ago(26 * 60 * MINUTE),
  })
  add({
    parentId: documents,
    kind: 'file',
    name: 'free-movies.exe',
    sizeBytes: 48 * MB,
    mimeType: MIME_TYPES['.exe'] ?? null,
    syncState: 'stored',
    deletedAt: ago(6 * 60 * MINUTE),
    moderationReason: 'Executable files are not allowed on this server.',
  })

  // ── Share links ───────────────────────────────────────────────────────────
  const share = (nodeId: string, fields: Partial<MockShare>): MockShare => ({
    id: makeUuid(random),
    nodeId,
    createdAt: ago(between(2, 20) * DAY),
    expiresAt: null,
    hasPassword: false,
    maxDownloads: null,
    downloadCount: 0,
    revokedAt: null,
    ...fields,
  })
  const budget = Object.values(nodes).find((node) => node.name === 'Budget 2026.xlsx')?.id ?? root
  const shares = [
    share(lisbon, {
      expiresAt: new Date(now + 7 * DAY).toISOString(),
      hasPassword: true,
      downloadCount: 3,
    }),
    share(resume, { maxDownloads: 10, downloadCount: 4 }),
    share(budget, { revokedAt: ago(2 * DAY) }),
    share(wedding, { expiresAt: ago(DAY), downloadCount: 12 }),
  ]

  return {
    version,
    user: {
      id: makeUuid(random),
      discordUserId: '123456789012345678',
      displayName: 'Demo User',
      avatarUrl: null,
      role: 'admin',
      rootFolderId: root,
      quotaBytes: 200 * GB,
    },
    signedIn: false,
    nodes,
    shares,
    uploads: {},
  }
}

/** Small, fast, seedable PRNG, so the demo drive is the same on every machine. */
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A random (version 4) UUID drawn from `random`. */
function makeUuid(random: () => number): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
