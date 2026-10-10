import { normalizeName, validateName } from '@dfs/shared'
import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { errorMessage } from '@/lib/api/client'
import { formText } from '@/lib/form-data'
import { useCreateFolder } from '../api'
import { NameField } from './name-field'

interface NewFolderDialogProps {
  parentId: string
  onClose: () => void
}

interface FormState {
  name: string
  error: string | null
}

export function NewFolderDialog({ parentId, onClose }: NewFolderDialogProps) {
  const createFolder = useCreateFolder()
  const [state, submit, pending] = useActionState(
    async (_previous: FormState, formData: FormData): Promise<FormState> => {
      const name = normalizeName(formText(formData, 'name'))
      const problem = validateName(name)
      if (problem) return { name, error: problem }
      try {
        await createFolder.mutateAsync({ parentId, name })
        onClose()
        return { name, error: null }
      } catch (error) {
        return { name, error: errorMessage(error) }
      }
    },
    { name: 'Untitled folder', error: null },
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
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          {/* The form resets after each submit; keep what was typed. */}
          <NameField defaultValue={state.name} error={state.error} />
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" disabled={pending} pending={pending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
