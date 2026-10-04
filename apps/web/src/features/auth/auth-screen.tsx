import type { ReactNode } from 'react'

/** The backdrop of the signed-out screens: centered content over a soft glow. */
export function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-1/2 size-[42rem] -translate-x-1/2 -translate-y-1/2 animate-in rounded-full bg-primary/10 blur-3xl duration-1000 ease-smooth fade-in-0"
      />
      {children}
    </main>
  )
}
