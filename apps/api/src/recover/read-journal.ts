import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { journalBatchContext, openObject, type MasterKeys } from '@dfs/crypto'
import { GZIP_FLAG } from '../journal.ts'
import type { FoundBatch, JournalSource } from './journal-source.ts'

// Reading the journal back (DESIGN.md §8): every batch opened with the key
// file, checked against what its message said, in number order, with no
// number missing; a batch posted twice is read once; a record cut into
// pieces is joined again. Records come out in ID order, which is the order
// their transactions committed.

const ungzipped = promisify(gunzip)

/** A journal record as recovery replays it. */
export interface JournalEntry {
  id: number
  kind: string
  /** When its transaction wrote it. */
  at: string
  record: Record<string, unknown>
}

/** A batch read, as `journal_batches` will list it again. */
export interface ReadBatch {
  batchNo: number
  firstId: number
  lastId: number
  recordCount: number
  sizeBytes: number
  sha256: Buffer
  message?: FoundBatch['message']
}

export interface ReadJournal {
  /** The database that wrote it (`instance.id`). */
  instanceId: string
  entries: JournalEntry[]
  batches: ReadBatch[]
  /** Batch numbers found twice, with the same bytes, and read once. */
  duplicates: number[]
}

/** Recovery can't go on safely; the message says why and what would let it. */
export class RecoveryError extends Error {
  override name = 'RecoveryError'
}

interface Payload {
  v: number
  instance: string
  batch: number
  records: JournalEntry[]
  piece?: { id: number; index: number; count: number; data: string }
}

/**
 * Reads every batch of one database's journal. `instanceId` picks the
 * database when the source holds several (development stacks share a
 * category); without it, there must be one.
 */
export async function readJournal(
  keys: MasterKeys,
  source: JournalSource,
  { instanceId }: { instanceId?: string } = {},
): Promise<ReadJournal> {
  const found: FoundBatch[] = []
  for await (const batch of source.batches()) found.push(batch)

  // Messages say whose they are; a local folder is told only once opened.
  const said = new Set(found.flatMap((batch) => batch.message?.instanceId ?? []))
  if (!instanceId && said.size > 1) {
    throw new RecoveryError(
      `The journal in ${source.describe} holds batches of ${String(said.size)} databases (${[...said].join(', ')}). Say which to recover with --instance.`,
    )
  }
  const wanted = instanceId ?? [...said][0]
  const mine = found.filter((batch) => !batch.message || batch.message.instanceId === wanted)

  const byNumber = Map.groupBy(mine, (batch) => batch.batchNo)
  const duplicates: number[] = []
  const chosen: FoundBatch[] = []
  for (const [batchNo, copies] of [...byNumber].sort(([a], [b]) => a - b)) {
    const [first, ...others] = copies
    if (!first) continue
    for (const other of others) {
      if (!Buffer.from(other.bytes).equals(Buffer.from(first.bytes))) {
        throw new RecoveryError(
          `Journal batch ${String(batchNo)} was found twice with different contents. Recovery stops rather than guess which is right.`,
        )
      }
    }
    if (others.length > 0) duplicates.push(batchNo)
    chosen.push(first)
  }

  const numbers = chosen.map((batch) => batch.batchNo)
  const last = numbers.at(-1) ?? 0
  const missing = []
  const present = new Set(numbers)
  for (let batchNo = 1; batchNo <= last; batchNo += 1) {
    if (!present.has(batchNo)) missing.push(batchNo)
  }
  if (missing.length > 0) {
    throw new RecoveryError(
      `Journal batches are missing: ${summarize(missing)}. The changes they held can't be replayed, so recovery stops.`,
    )
  }

  let instance = wanted
  const entries: JournalEntry[] = []
  const batches: ReadBatch[] = []
  const pieces = new Map<number, string[]>()
  for (const batch of chosen) {
    const payload = await openBatch(keys, batch)
    instance ??= payload.instance
    if (payload.instance !== instance) {
      throw new RecoveryError(
        `Journal batch ${String(batch.batchNo)} belongs to database ${payload.instance}, not ${instance}. Say which to recover with --instance.`,
      )
    }
    let ids: number[] = payload.records.map((entry) => entry.id)
    if (payload.piece) {
      const { id, index, count, data } = payload.piece
      const parts = pieces.get(id) ?? []
      if (index !== parts.length) {
        throw new RecoveryError(
          `Journal batch ${String(batch.batchNo)} holds piece ${String(index + 1)} of record ${String(id)}, out of order.`,
        )
      }
      parts.push(data)
      pieces.set(id, parts)
      if (parts.length === count) {
        entries.push(JSON.parse(parts.join('')) as JournalEntry)
        pieces.delete(id)
      }
      ids = [id]
    } else {
      entries.push(...payload.records)
    }
    const firstId = ids[0] ?? 0
    const lastId = ids.at(-1) ?? 0
    if (batch.message && (batch.message.firstId !== firstId || batch.message.lastId !== lastId)) {
      throw new RecoveryError(
        `Journal batch ${String(batch.batchNo)} holds records ${String(firstId)}–${String(lastId)}, but its message says ${String(batch.message.firstId)}–${String(batch.message.lastId)}.`,
      )
    }
    batches.push({
      batchNo: batch.batchNo,
      firstId,
      lastId,
      recordCount: payload.piece ? 1 : payload.records.length,
      sizeBytes: batch.bytes.length,
      sha256: createHash('sha256').update(batch.bytes).digest(),
      message: batch.message,
    })
  }
  if (pieces.size > 0) {
    throw new RecoveryError(
      `Record ${String([...pieces.keys()][0])} was cut into pieces, and the journal ends before its last one.`,
    )
  }

  entries.sort((a, b) => a.id - b.id)
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index]?.id === entries[index - 1]?.id) {
      throw new RecoveryError(`Journal record ${String(entries[index]?.id)} appears twice.`)
    }
  }
  if (!instance) throw new RecoveryError(`No journal batch was found in ${source.describe}.`)
  return { instanceId: instance, entries, batches, duplicates }
}

async function openBatch(keys: MasterKeys, batch: FoundBatch): Promise<Payload> {
  let opened
  try {
    opened = await openObject(keys, batch.bytes, journalBatchContext(batch.batchNo))
  } catch (error) {
    throw new RecoveryError(
      `Journal batch ${String(batch.batchNo)} couldn’t be opened: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const plaintext =
    opened.flags & GZIP_FLAG ? await ungzipped(opened.plaintext) : Buffer.from(opened.plaintext)
  const payload = JSON.parse(plaintext.toString('utf8')) as Payload
  if (payload.v !== 1) {
    throw new RecoveryError(
      `Journal batch ${String(batch.batchNo)} is in format ${String(payload.v)}, which this version of dfs can’t read.`,
    )
  }
  if (payload.batch !== batch.batchNo) {
    throw new RecoveryError(
      `Journal batch ${String(batch.batchNo)} says it is batch ${String(payload.batch)}.`,
    )
  }
  return payload
}

/** `3, 7–9, 12`. */
function summarize(numbers: readonly number[]): string {
  const runs: string[] = []
  let start = numbers[0]
  let previous = start
  for (const number of [...numbers.slice(1), Number.NaN]) {
    if (start === undefined || previous === undefined) break
    if (number === previous + 1) {
      previous = number
      continue
    }
    runs.push(start === previous ? String(start) : `${String(start)}–${String(previous)}`)
    start = number
    previous = number
  }
  return runs.join(', ')
}
