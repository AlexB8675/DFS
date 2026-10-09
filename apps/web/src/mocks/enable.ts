/** Starts the mock API before the app renders. A no-op in production builds. */
export async function enableMocking(): Promise<void> {
  // Inlined rather than using `mocksEnabled` from lib/env: Vite replaces
  // `import.meta.env.DEV` with `false` here, so the bundler drops the imports
  // below and no mock code ships in production.
  if (!import.meta.env.DEV || import.meta.env.VITE_API_MOCKS === 'off') return
  const [{ worker }, { keepMockingActive }, { loadSampleVideo }] = await Promise.all([
    import('./browser'),
    import('./keep-active'),
    import('./samples'),
  ])
  await Promise.all([
    worker.start({ onUnhandledFrame: 'bypass', quiet: true }),
    // Without it, videos say they can't play: the demo still works.
    loadSampleVideo().catch(() => undefined),
  ])
  keepMockingActive()
}
