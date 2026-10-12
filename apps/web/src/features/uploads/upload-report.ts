import type { Unreadable } from './picked-files'
import type { UploadItem } from './upload-store'

// What became of every file in this page's uploads (DESIGN.md §10.2): each a
// row of the panel's report, in one of a few kinds, and the lot as a CSV to
// keep once the page is gone.

export type ReportKind = 'failed' | 'unreadable' | 'pending' | 'uploaded' | 'unchanged' | 'skipped'

/** The kinds in the order the report shows them: what needs a look first. */
export const REPORT_KINDS: { kind: ReportKind; label: string }[] = [
  { kind: 'failed', label: 'Failed' },
  { kind: 'unreadable', label: 'Not read' },
  { kind: 'pending', label: 'In progress' },
  { kind: 'uploaded', label: 'Uploaded' },
  { kind: 'unchanged', label: 'Already there' },
  { kind: 'skipped', label: 'Skipped' },
]

export interface ReportRow {
  /** The upload's, to retry it; none for what the browser wouldn't read. */
  uploadId: string | null
  kind: ReportKind
  /** The name it was uploaded under. */
  name: string
  /** Where it was on disk, as far as the browser says (`UploadItem.path`). */
  path: string
  /** What became of it, in a word or two. */
  outcome: string
  /** Why, or more of what happened. */
  detail: string
  sizeBytes: number | null
}

/** Which part of the report an upload goes in. */
export function reportKind(item: UploadItem): ReportKind {
  switch (item.status) {
    case 'failed':
      return 'failed'
    case 'done':
      return item.syncState === 'failed' ? 'failed' : 'uploaded'
    case 'unchanged':
      return 'unchanged'
    case 'canceled':
      return 'skipped'
    default:
      return 'pending'
  }
}

/** How many of each kind: the uploads, and what the browser wouldn't read. */
export function kindCounts(
  items: readonly UploadItem[],
  unreadable: number,
): Record<ReportKind, number> {
  const counts: Record<ReportKind, number> = {
    failed: 0,
    unreadable,
    pending: 0,
    uploaded: 0,
    unchanged: 0,
    skipped: 0,
  }
  for (const item of items) counts[reportKind(item)] += 1
  return counts
}

/** Every row, in the report's order of kinds, each kind in the order its files came. */
export function reportRows(
  items: readonly UploadItem[],
  unreadable: readonly Unreadable[],
): ReportRow[] {
  const rows = [...items.map(uploadRow), ...unreadable.map(unreadableRow)]
  const order = REPORT_KINDS.map((entry) => entry.kind)
  return rows.toSorted((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
}

/** How the engine words a file skipped by choice. */
const SKIPPED = 'Skipped: '

export function uploadRow(item: UploadItem): ReportRow {
  const row = { uploadId: item.id, name: item.name, path: item.path, sizeBytes: item.file.size }
  switch (item.status) {
    case 'failed':
      return { ...row, kind: 'failed', outcome: 'Failed', detail: item.error ?? 'Upload failed' }
    case 'done':
      if (item.syncState === 'failed') {
        return {
          ...row,
          kind: 'failed',
          outcome: 'Not stored',
          detail: 'Uploaded, but it couldn’t be stored on Discord',
        }
      }
      return {
        ...row,
        kind: 'uploaded',
        outcome: 'Uploaded',
        detail: item.syncState === 'stored' ? 'On Discord' : 'Syncing to Discord',
      }
    case 'unchanged':
      return {
        ...row,
        kind: 'unchanged',
        outcome: 'Already there',
        detail: 'The same file was uploaded before: same size and modification date',
      }
    case 'canceled': {
      // "Skipped: “a.txt” already exists" says it twice beside its outcome.
      const skipped = item.error?.startsWith(SKIPPED) ?? false
      return {
        ...row,
        kind: 'skipped',
        outcome: skipped ? 'Skipped' : 'Canceled',
        detail: (skipped ? item.error?.slice(SKIPPED.length) : item.error) ?? 'Canceled',
      }
    }
    case 'queued':
      return { ...row, kind: 'pending', outcome: 'In progress', detail: 'Waiting' }
    case 'uploading':
      return { ...row, kind: 'pending', outcome: 'In progress', detail: 'Uploading' }
    case 'paused':
      return { ...row, kind: 'pending', outcome: 'In progress', detail: 'Paused' }
    case 'conflict':
      return {
        ...row,
        kind: 'pending',
        outcome: 'In progress',
        detail: 'Already exists: waiting for your choice',
      }
  }
}

export function unreadableRow({ path, operation, reason }: Unreadable): ReportRow {
  return {
    uploadId: null,
    kind: 'unreadable',
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    outcome: 'Not read',
    detail: `The browser couldn’t ${operation}: ${reason}`,
    sizeBytes: null,
  }
}

/**
 * The report as CSV, a row a file, for a spreadsheet: comma-separated, every
 * field that needs it quoted, lines ending in CRLF. A field a spreadsheet
 * would take for a formula (a file named `=SUM(…).txt`) starts with `'`.
 */
export function reportCsv(rows: readonly ReportRow[]): string {
  const lines = [
    ['Path', 'Name', 'Outcome', 'Detail', 'Size (bytes)'],
    ...rows.map((row) => [
      row.path,
      row.name,
      row.outcome,
      row.detail,
      row.sizeBytes === null ? '' : String(row.sizeBytes),
    ]),
  ]
  return `${lines.map((fields) => fields.map(csvField).join(',')).join('\r\n')}\r\n`
}

function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}
