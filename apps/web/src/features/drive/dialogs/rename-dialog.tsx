import { normalizeName, validateName, type DriveNode } from '@dfs/shared'
import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { errorMessage } from '@/lib/api/client'
import { formText } from '@/lib/form-data'
import { useRenameNode } from '../api'
import { NameField } from './name-field'

interface RenameDialogProps {
  node: DriveNode
  onClose: () => void
}

interface FormState {
  name: string
  error: string | null
}

export function RenameDialog({ node, onClose }: RenameDialogProps) {
  const rename = useRenameNode()
  const [state, submit, pending] = useActionState(
    async (_previous: FormState, formData: FormData): Promise<FormState> => {
      const name = normalizeName(formText(formData, 'name'))
      const problem = validateName(name)
      if (problem) return { name, error: problem }
      try {
        if (name !== node.name) await rename.mutateAsync({ id: node.id, name })
        onClose()
        return { name, error: null }
      } catch (error) {
        return { name, error: errorMessage(error) }
      }
    },
    { name: node.name, error: null },
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form action={submit}>
          <DialogHeader>
            <DialogTitle>Rename {node.kind}</DialogTitle>
            <DialogDescription className="sr-only">
              Enter a new name for “{node.name}”.
            </DialogDescription>
          </DialogHeader>
          <NameField
            defaultValue={state.name}
            error={state.error}
            selectBaseName={node.kind === 'file'}
          />
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />} Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
