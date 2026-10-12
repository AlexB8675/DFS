import type { SyncState } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { kindCounts, reportCsv, reportRows, unreadableRow, uploadRow } from './upload-report'
import type { UploadItem, UploadStatus } from './upload-store'

function upload(
  status: UploadStatus,
  path: string,
  { syncState = null, error = null }: { syncState?: SyncState | null; error?: string | null } = {},
): UploadItem {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return {
    id: crypto.randomUUID(),
    file: new File([new Uint8Array(3)], name),
    parentId: 'folder',
    path,
    name,
    status,
    uploadedBytes: 0,
    nodeId: null,
    syncState,
    retrying: false,
    pausedUntil: null,
    conflict: null,
    error,
  }
}

describe('the upload report (§10.2)', () => {
  it('says what became of each file, and why', () => {
    const rows = reportRows(
      [
        upload('done', 'Trip/a.jpg', { syncState: 'stored' }),
        upload('failed', 'Trip/b.jpg', { error: 'Not enough storage left for “b.jpg”.' }),
        upload('unchanged', 'Trip/c.jpg'),
        upload('done', 'Trip/d.jpg', { syncState: 'failed' }),
        upload('canceled', 'Trip/e.jpg', { error: 'Skipped: “e.jpg” already exists' }),
        upload('paused', 'Trip/f.jpg'),
      ],
      [{ path: 'Trip/venv/lib64', operation: 'list the folder', reason: 'InvalidStateError' }],
    )
    expect(rows.map((row) => [row.kind, row.path, row.outcome, row.detail])).toEqual([
      ['failed', 'Trip/b.jpg', 'Failed', 'Not enough storage left for “b.jpg”.'],
      ['failed', 'Trip/d.jpg', 'Not stored', 'Uploaded, but it couldn’t be stored on Discord'],
      [
        'unreadable',
        'Trip/venv/lib64',
        'Not read',
        'The browser couldn’t list the folder: InvalidStateError',
      ],
      ['pending', 'Trip/f.jpg', 'In progress', 'Paused'],
      ['uploaded', 'Trip/a.jpg', 'Uploaded', 'On Discord'],
      [
        'unchanged',
        'Trip/c.jpg',
        'Already there',
        'The same file was uploaded before: same size and modification date',
      ],
      ['skipped', 'Trip/e.jpg', 'Skipped', '“e.jpg” already exists'],
    ])
    expect(
      unreadableRow({ path: 'a/b/c.txt', operation: 'open the file', reason: 'x' }),
    ).toMatchObject({
      name: 'c.txt',
      uploadId: null,
      sizeBytes: null,
    })
  })

  it('counts each kind, those the browser wouldn’t read too', () => {
    expect(
      kindCounts([upload('done', 'a'), upload('failed', 'b'), upload('queued', 'c')], 2),
    ).toEqual({ failed: 1, unreadable: 2, pending: 1, uploaded: 1, unchanged: 0, skipped: 0 })
  })

  it('writes CSV a spreadsheet reads as written, formulas left as text', () => {
    const row = uploadRow(
      upload('failed', 'Q4, "final"/=SUM(A1).txt', { error: 'Line one\nline two' }),
    )
    expect(reportCsv([row])).toBe(
      'Path,Name,Outcome,Detail,Size (bytes)\r\n' +
        '"Q4, ""final""/=SUM(A1).txt",\'=SUM(A1).txt,Failed,"Line one\nline two",3\r\n',
    )
    expect(
      reportCsv([unreadableRow({ path: '-rf', operation: 'open the file', reason: 'x' })]),
    ).toContain("'-rf,'-rf,Not read")
  })
})
