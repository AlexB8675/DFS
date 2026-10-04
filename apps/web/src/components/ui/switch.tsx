import * as React from 'react'
import { cn } from 'cn'
import { Switch as SwitchPrimitive } from 'radix-ui'

/** An on/off switch whose knob bounces across, like iOS. */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer pressable inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 rounded-full bg-background shadow-sm transition-transform motion-bounce data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 dark:data-[state=unchecked]:bg-foreground/80"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
