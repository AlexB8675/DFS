import { Eye, EyeOff } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** A password field with a button that shows what was typed. */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const [visible, setVisible] = useState(false)
  const Icon = visible ? EyeOff : Eye

  return (
    <div className="relative">
      <Input
        type={visible ? 'text' : 'password'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn('pr-9', className)}
        {...props}
      />
      <button
        type="button"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        className="pressable absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
        onClick={() => {
          setVisible((shown) => !shown)
        }}
      >
        <Icon
          key={String(visible)}
          className="size-4 animate-in zoom-in-75 fade-in-0 motion-bounce"
        />
      </button>
    </div>
  )
}
