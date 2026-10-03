import { splitExtension } from '@dfs/shared'
import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface NameFieldProps {
  defaultValue: string
  error: string | null
  /** Pre-selects the name without its extension, so typing replaces just that. */
  selectBaseName?: boolean
}

/** The name input shared by the new-folder and rename dialogs. */
export function NameField({ defaultValue, error, selectBaseName = false }: NameFieldProps) {
  const id = useId()
  const errorId = `${id}-error`

  return (
    <div className="grid gap-2 py-2">
      <Label htmlFor={id}>Name</Label>
      <Input
        id={id}
        name="name"
        defaultValue={defaultValue}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        onFocus={(event) => {
          const input = event.currentTarget
          const end = selectBaseName ? splitExtension(input.value).base.length : input.value.length
          input.setSelectionRange(0, end)
        }}
      />
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
