import { splitExtension, type SyncState } from '@dfs/shared'
import type { MockAuditEntry, MockChannel, MockNode, MockShare, MockState, MockUser } from './db'

// Builds a deterministic demo drive. It deliberately includes the edge cases
// the UI must handle: a folder with 6,000 files, deep nesting, long names, an
// empty folder, every sync state, trashed and moderated items, and share links.
// A few other users, storage channels and an audit log feed the admin pages.

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

/** Sign-ins to try, offered on the login page in demo mode (`GET /api/dev/accounts`). */
export const DEMO_ACCOUNTS = [
  { username: 'demo', password: 'demo-password', label: 'Owner and admin' },
  { username: 'sam', password: 'sam-password', label: 'A regular user' },
  { username: 'taylor', password: 'welcome-taylor', label: 'First sign-in' },
  { username: 'morgan', password: 'welcome-morgan', label: 'Temporary password expired' },
  { username: 'jordan', password: 'jordan-password', label: 'Disabled account' },
]

export function createSeed(version: number): MockState {
  const random = mulberry32(20261003)
  const now = Date.now()
  const nodes: Record<string, MockNode> = {}

  const between = (min: number, max: number) => Math.round(min + random() * (max - min))
  const ago = (ms: number) => new Date(now - ms).toISOString()
  const demoUserId = makeUuid(random)
  /** Whose drive `add` is filling. */
  let owner = demoUserId

  function add(fields: Pick<MockNode, 'parentId' | 'kind' | 'name'> & Partial<MockNode>): MockNode {
    const updatedAt = fields.updatedAt ?? ago(between(30, 900) * DAY)
    const node: MockNode = {
      id: makeUuid(random),
      ownerId: owner,
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
  // Readable tokens, so the demo links can be tried: /s/demo-lisbon (password
  // "lisbon"), /s/demo-resume, and the expired and revoked ones.
  const share = (nodeId: string, token: string, fields: Partial<MockShare>): MockShare => ({
    id: makeUuid(random),
    nodeId,
    token,
    password: null,
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
    share(lisbon, 'demo-lisbon', {
      expiresAt: new Date(now + 7 * DAY).toISOString(),
      password: 'lisbon',
      hasPassword: true,
      downloadCount: 3,
    }),
    share(resume, 'demo-resume', { maxDownloads: 10, downloadCount: 4 }),
    share(budget, 'demo-revoked', { revokedAt: ago(2 * DAY) }),
    share(wedding, 'demo-expired', { expiresAt: ago(DAY), downloadCount: 12 }),
    share(documents, 'demo-documents', {}),
  ]

  // ── Other users (for the admin pages) ─────────────────────────────────────
  // The ones to try are listed in DEMO_ACCOUNTS.
  const demoUser: MockUser = {
    id: demoUserId,
    username: 'demo',
    password: 'demo-password',
    displayName: 'Demo User',
    role: 'admin',
    isOwner: true,
    rootFolderId: root,
    quotaBytes: 200 * GB,
    disabled: false,
    activatedAt: ago(420 * DAY),
    temporaryPasswordExpiresAt: null,
    createdAt: ago(420 * DAY),
    lastSeenAt: ago(MINUTE),
  }
  const users = [demoUser]

  function user(
    fields: Pick<MockUser, 'username' | 'displayName' | 'role' | 'quotaBytes'> & Partial<MockUser>,
  ) {
    const id = makeUuid(random)
    owner = id
    const userRoot = folder(null, 'My Drive')
    const createdAt = ago(between(30, 400) * DAY)
    users.push({
      id,
      password: `${fields.username}-password`,
      isOwner: false,
      rootFolderId: userRoot,
      disabled: false,
      activatedAt: createdAt,
      temporaryPasswordExpiresAt: null,
      createdAt,
      lastSeenAt: ago(between(1, 72) * 60 * MINUTE),
      ...fields,
    })
    return userRoot
  }

  const sam = user({
    username: 'sam',
    displayName: 'Sam Rivera',
    role: 'user',
    quotaBytes: 100 * GB,
  })
  photos(folder(sam, 'Photos'), 140, 1, 20 * DAY)
  const samWork = folder(sam, 'Work')
  file(samWork, 'Quarterly report.pdf', 4.2 * MB)
  file(samWork, 'Roadmap.xlsx', 220 * KB)
  file(samWork, 'Onboarding.docx', 96 * KB)
  const games = folder(sam, 'Games')
  file(games, 'cracked-launcher.exe', 64 * MB, { age: 2 * DAY })
  file(games, 'saves.zip', 380 * MB)

  const priya = user({
    username: 'priya',
    displayName: 'Priya Patel',
    role: 'admin',
    quotaBytes: 500 * GB,
  })
  const research = folder(priya, 'Research')
  for (let i = 1; i <= 24; i += 1)
    file(research, `Paper ${String(i).padStart(2, '0')}.pdf`, between(1 * MB, 9 * MB))
  const datasets = folder(research, 'Datasets')
  file(datasets, 'measurements-2025.csv', 1.8 * GB)
  file(datasets, 'raw-images.tar.gz', 36 * GB, { syncState: 'syncing' })
  const lectures = folder(priya, 'Lectures')
  for (let i = 1; i <= 12; i += 1) file(lectures, `Week ${i}.mp4`, between(400 * MB, 1200 * MB))

  const jordan = user({
    username: 'jordan',
    displayName: 'Jordan Lee',
    role: 'user',
    quotaBytes: 20 * GB,
    disabled: true,
    lastSeenAt: ago(90 * DAY),
  })
  const oldStuff = folder(jordan, 'Old stuff')
  file(oldStuff, 'notes.txt', 3 * KB)
  file(oldStuff, 'scan.pdf', 2.4 * MB)

  const alex = user({
    username: 'alex',
    displayName: 'Alex Kim',
    role: 'user',
    quotaBytes: 50 * GB,
  })
  const alexBackups = folder(alex, 'Backups')
  file(alexBackups, 'desktop-full.tar.gz', 38 * GB)
  file(alexBackups, 'photos-2025.zip', 7.5 * GB)
  file(folder(alex, 'Documents'), 'Taxes 2025.pdf', 1.1 * MB)

  // Accounts that haven't signed in yet: one waiting, one whose temporary
  // password ran out (§7.1).
  user({
    username: 'taylor',
    password: 'welcome-taylor',
    displayName: 'Taylor Brooks',
    role: 'user',
    quotaBytes: 100 * GB,
    activatedAt: null,
    temporaryPasswordExpiresAt: new Date(now + 6 * DAY).toISOString(),
    createdAt: ago(DAY),
    lastSeenAt: null,
  })
  user({
    username: 'morgan',
    password: 'welcome-morgan',
    displayName: 'Morgan Diaz',
    role: 'user',
    quotaBytes: 50 * GB,
    activatedAt: null,
    temporaryPasswordExpiresAt: ago(2 * DAY),
    createdAt: ago(9 * DAY),
    lastSeenAt: null,
  })

  // ── Storage channels and the audit log ────────────────────────────────────
  const channel = (name: string, enabled: boolean, age: number): MockChannel => ({
    id: makeUuid(random),
    discordChannelId:
      String(between(100_000_000, 999_999_999)) + String(between(100_000_000, 999_999_999)),
    name,
    enabled,
    createdAt: ago(age),
  })
  const channels = [
    channel('dfs-legacy', false, 400 * DAY),
    channel('storage-00', true, 300 * DAY),
    channel('storage-01', true, 300 * DAY),
    channel('storage-02', true, 45 * DAY),
  ]

  const audit: MockAuditEntry[] = []
  const log = (
    age: number,
    actorName: string,
    action: string,
    target: string,
    details: string | null = null,
  ) => {
    audit.push({ id: makeUuid(random), at: ago(age), actorName, action, target, details })
  }
  log(2 * 60 * MINUTE, 'System', 'backup.completed', 'Database', 'Dump 1.2 GB, 3 blobs')
  log(
    6 * 60 * MINUTE,
    'Demo User',
    'node.moderated',
    'free-movies.exe (Demo User)',
    'Executable files are not allowed on this server.',
  )
  log(DAY, 'Demo User', 'user.created', 'Taylor Brooks', '@taylor · 100 GB · User')
  log(2 * DAY, 'Priya Patel', 'user.updated', 'Sam Rivera', 'Quota 50 GB → 100 GB')
  log(9 * DAY, 'Demo User', 'user.created', 'Morgan Diaz', '@morgan · 50 GB · User')
  log(3 * DAY, 'System', 'scrub.completed', 'All channels', 'Checked 41,208 blobs, 1 lost')
  log(9 * DAY, 'System', 'blob.lost', 'storage-00', 'Old camcorder tape 1998.avi')
  log(45 * DAY, 'Demo User', 'channel.created', 'storage-02', null)
  log(60 * DAY, 'Demo User', 'channel.disabled', 'dfs-legacy', null)
  log(90 * DAY, 'Priya Patel', 'user.disabled', 'Jordan Lee', null)
  for (let day = 4; day <= 40; day += 1) {
    log(
      day * DAY + between(0, 600) * MINUTE,
      'System',
      'backup.completed',
      'Database',
      `Dump ${(1 + random() * 0.2).toFixed(1)} GB`,
    )
  }
  log(12 * MINUTE, 'Demo User', 'upload.completed', 'Budget 2026.xlsx', '48 KB, new version')
  log(40 * MINUTE, 'Demo User', 'node.purged', 'Old notes.txt', 'emptied the trash')
  log(3 * 60 * MINUTE, 'Demo User', 'node.trashed', 'Old notes.txt', null)
  log(26 * 60 * MINUTE, 'Demo User', 'upload.completed', 'Tram ride.mp4', '182 MB')
  log(5 * DAY, 'Demo User', 'node.restored', 'Resume 2026.docx', null)
  audit.sort((a, b) => b.at.localeCompare(a.at))

  return {
    version,
    userId: demoUserId,
    users,
    signedIn: false,
    nodes,
    shares,
    uploads: {},
    channels,
    audit,
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
