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
  // Keyed, so each upload starts with its own suggested name.
  return <ConflictQuestion key={entry.id} entry={entry} waiting={conflicts.length} />
}

function ConflictQuestion({ entry, waiting }: { entry: UploadEntry; waiting: number }) {
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
              {conflict.links > 0 &&
                ` Its ${formatCount(conflict.links, 'share link')} will keep sharing the file as it is now.`}
            </DialogDescription>
          </DialogHeader>

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
