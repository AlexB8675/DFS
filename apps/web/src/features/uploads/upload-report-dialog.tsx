import { Copy, Download, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useStore } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { VirtualList } from '@/components/virtual-list'
import { saveBlob } from '@/lib/download'
import { formatCount } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Unreadable } from './picked-files'
import { uploadEngine } from './upload-engine'
import {
  kindCounts,
  REPORT_KINDS,
  reportCsv,
  reportKind,
  reportRows,
  unreadableRow,
  uploadRow,
  type ReportKind,
  type ReportRow,
} from './upload-report'
import { useUploadStore, type UploadEntry } from './upload-store'

const ROW_HEIGHT = 64

/**
 * What became of every file in this page's uploads (§10.2), by kind: failed,
 * not read by the browser, still going, uploaded, already there, skipped.
 * Each with its name, where it was on disk and why; a kind to copy, all of it
 * to download as CSV, and the failed ones to retry. Opens on `start`, or on
 * the first kind that has anything.
 */
export function UploadReportDialog({
  open,
  onOpenChange,
  start,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  start?: ReportKind
}) {
  // Small numbers, compared one by one: renders when a file changes kind.
  const counts = useUploadStore(
    useShallow((state) =>
      kindCounts(
        state.items.map((entry) => entry.store.getState()),
        state.unreadable.length,
      ),
    ),
  )
  const [chosen, setChosen] = useState<ReportKind | null>(null)
  const firstFound = REPORT_KINDS.find((entry) => counts[entry.kind] > 0)?.kind ?? 'failed'
  const kind = chosen ?? start ?? firstFound
  const shown = REPORT_KINDS.filter((entry) => counts[entry.kind] > 0 || entry.kind === kind)

  function rowsOf(only?: ReportKind): ReportRow[] {
    const { items, unreadable } = useUploadStore.getState()
    const rows = reportRows(
      items.map((entry) => entry.store.getState()),
      unreadable,
    )
    return only ? rows.filter((row) => row.kind === only) : rows
  }

  async function copy() {
    const lines = rowsOf(kind).map((row) => `${row.path} — ${row.outcome}: ${row.detail}`)
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      toast.success(`Copied ${formatCount(lines.length, 'line')}`)
    } catch {
      toast.error('Could not copy the list. Download the report instead.')
    }
  }

  function download() {
    // A byte-order mark, so spreadsheets read the names as UTF-8.
    const csv = `\uFEFF${reportCsv(rowsOf())}`
    saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), reportFileName(new Date()))
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setChosen(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload report</DialogTitle>
          <DialogDescription>
            Paths are inside the folder you dropped or picked: browsers don’t tell a page the rest
            of where a file is on your disk. To finish a folder, drop it again: files already
            uploaded are skipped.
          </DialogDescription>
        </DialogHeader>
        <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={0}
            value={kind}
            aria-label="What became of them"
            onValueChange={(value) => {
              const found = REPORT_KINDS.find((entry) => entry.kind === value)
              if (found) setChosen(found.kind)
            }}
          >
            {shown.map((entry) => (
              <ToggleGroupItem
                key={entry.kind}
                value={entry.kind}
                className="gap-1.5 px-2.5 tabular-nums"
              >
                {entry.label}
                <span className="text-muted-foreground">{counts[entry.kind].toLocaleString()}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {kind === 'unreadable' ? <UnreadableList /> : <UploadList kind={kind} />}
        <DialogFooter>
          {counts[kind] > 0 && (
            <Button variant="outline" onClick={() => void copy()}>
              <Copy />
              Copy list
            </Button>
          )}
          <Button variant="outline" onClick={download}>
            <Download />
            Download report
          </Button>
          {kind === 'failed' && <RetryFailed />}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function UploadList({ kind }: { kind: ReportKind }) {
  // The same entries, compared one by one: renders when one joins or leaves.
  const entries = useUploadStore(
    useShallow((state) =>
      state.items.filter((entry) => reportKind(entry.store.getState()) === kind),
    ),
  )
  if (entries.length === 0) return <Nothing />
  return (
    <VirtualList
      role="list"
      aria-label="Files"
      className="max-h-[min(24rem,50dvh)] rounded-md border"
      items={entries}
      getKey={(entry) => entry.id}
      itemHeight={ROW_HEIGHT}
      renderItem={(entry) => <UploadReportRow entry={entry} />}
    />
  )
}

function UnreadableList() {
  const unreadable = useUploadStore((state) => state.unreadable)
  if (unreadable.length === 0) return <Nothing />
  return (
    <VirtualList
      role="list"
      aria-label="Files"
      className="max-h-[min(24rem,50dvh)] rounded-md border"
      items={unreadable}
      getKey={(entry: Unreadable) => entry.path}
      itemHeight={ROW_HEIGHT}
      renderItem={(entry) => <ReportLine row={unreadableRow(entry)} />}
    />
  )
}

function UploadReportRow({ entry }: { entry: UploadEntry }) {
  const item = useStore(entry.store)
  return <ReportLine row={uploadRow(item)} />
}

function ReportLine({ row }: { row: ReportRow }) {
  const trouble = row.kind === 'failed' || row.kind === 'unreadable'
  return (
    <div
      role="listitem"
      className="flex h-full min-w-0 flex-col justify-center border-b px-3 text-sm last:border-b-0"
    >
      <p className="truncate font-medium" title={row.name}>
        {row.name}
      </p>
      <p className="truncate font-mono text-xs text-muted-foreground" title={row.path}>
        {row.path}
      </p>
      <p
        className={cn('truncate text-xs', trouble ? 'text-destructive' : 'text-muted-foreground')}
        title={row.detail}
      >
        {row.outcome === row.detail ? row.outcome : `${row.outcome} · ${row.detail}`}
      </p>
    </div>
  )
}

function Nothing() {
  return (
    <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">
      None now.
    </p>
  )
}

/** Starts again every upload that failed; those uploaded but not stored are the server's to retry. */
function RetryFailed() {
  const failed = useUploadStore(
    useShallow((state) =>
      state.items.filter((entry) => entry.store.getState().status === 'failed'),
    ),
  )
  if (failed.length === 0) return null
  return (
    <Button
      onClick={() => {
        for (const entry of failed) uploadEngine.retry(entry.id)
      }}
    >
      <RotateCcw />
      {failed.length === 1 ? 'Retry it' : `Retry ${formatCount(failed.length, 'upload')}`}
    </Button>
  )
}

/** `DFS upload report 2026-10-12 14.05.csv`, in local time; no colons, which Windows refuses. */
function reportFileName(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  return `DFS upload report ${day} ${pad(at.getHours())}.${pad(at.getMinutes())}.csv`
}
