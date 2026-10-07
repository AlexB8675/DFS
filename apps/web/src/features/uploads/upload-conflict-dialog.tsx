import { normalizeName, validateName } from '@dfs/shared'
import { useState } from 'react'
import { useStore } from 'zustand'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { linkCount } from '@/features/shares/api'
import { LinkWarning } from '@/features/shares/link-warning'
import { formatCount } from '@/lib/format'
import { uploadEngine, type ConflictChoice } from './upload-engine'
import { useUploadStore, type UploadEntry } from './upload-store'

/**
 * Asks before an upload replaces a file of the same name (D20): replace it
 * with a new version, keep both under another name, or skip the upload.
 * One upload at a time, in the order they came; closing it skips the file.
 */
export function UploadConflictDialog() {
  const conflicts = useUploadStore((state) => state.conflicts)
  const items = useUploadStore((state) => state.items)
  const entry = items.find((candidate) => candidate.id === conflicts[0])
  if (!entry) return null
  // What "for all" would replace: the links of every file waiting.
  const waiting = new Set(conflicts)
  const allLinks = items
    .filter((candidate) => waiting.has(candidate.id))
    .reduce((total, candidate) => total + (candidate.store.getState().conflict?.links ?? 0), 0)
  // Keyed, so each upload starts with its own suggested name.
  return (
    <ConflictQuestion key={entry.id} entry={entry} waiting={conflicts.length} allLinks={allLinks} />
  )
}

function ConflictQuestion({
  entry,
  waiting,
  allLinks,
}: {
  entry: UploadEntry
  waiting: number
  allLinks: number
}) {
  const item = useStore(entry.store)
  const [name, setName] = useState(item.conflict?.suggestedName ?? item.name)
  const [forAll, setForAll] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const conflict = item.conflict
  if (!conflict) return null
  const others = waiting - 1

  const answer = (choice: ConflictChoice) => {
    uploadEngine.resolveConflict(item.id, choice, forAll)
  }
  const keepBoth = () => {
    const chosen = normalizeName(name)
    const invalid = validateName(chosen)
    if (invalid) {
      setProblem(invalid)
      return
    }
    answer({ action: 'keep', name: chosen })
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Closing never replaces anything: the file is left out.
        if (!open) answer({ action: 'skip' })
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            keepBoth()
          }}
        >
          <DialogHeader>
            <DialogTitle className="truncate">“{item.name}” already exists</DialogTitle>
            <DialogDescription>
              Replace it with the file you’re uploading, keep both, or skip this one.
            </DialogDescription>
          </DialogHeader>

          {(forAll ? allLinks : conflict.links) > 0 && (
            <LinkWarning>
              {forAll
                ? `These files have ${linkCount(allLinks)}. Replacing them won’t update the links: they keep sharing the versions you replace, which stay, counting toward your storage, until the links stop working.`
                : `This file has ${linkCount(conflict.links)}. Replacing the file won’t update ${conflict.links === 1 ? 'the link: it keeps' : 'the links: they keep'} sharing the version you replace, which stays, counting toward your storage, until ${conflict.links === 1 ? 'the link stops' : 'they stop'} working.`}
            </LinkWarning>
          )}

          <div className="grid gap-2">
            <Label htmlFor="conflict-name">Name for the copy, if you keep both</Label>
            <Input
              id="conflict-name"
              value={name}
              disabled={forAll}
              aria-invalid={problem !== null}
              onChange={(event) => {
                setName(event.target.value)
                setProblem(null)
              }}
            />
            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
          </div>

          {others > 0 && (
            <div className="flex items-center gap-2">
              <Checkbox
                id="conflict-all"
                checked={forAll}
                onCheckedChange={(checked) => {
                  setForAll(checked === true)
                }}
              />
              <Label htmlFor="conflict-all" className="font-normal">
                Do this for the other {formatCount(others, 'file')} that already{' '}
                {others === 1 ? 'exists' : 'exist'}
                {forAll && ' (copies are numbered)'}
              </Label>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                answer({ action: 'skip' })
              }}
            >
              Skip
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                answer({ action: 'replace' })
              }}
            >
              Replace
            </Button>
            <Button
              type={forAll ? 'button' : 'submit'}
              onClick={
                forAll
                  ? () => {
                      answer({ action: 'keep' })
                    }
                  : undefined
              }
            >
              Keep both
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
