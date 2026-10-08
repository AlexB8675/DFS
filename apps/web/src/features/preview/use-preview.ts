import { useLocation, useNavigate, useSearchParams } from 'react-router'

/** Set on the history entry that opened the viewer, so closing it goes back to the one before. */
interface PreviewState {
  preview?: boolean
}

/**
 * The viewer's place in the address (§10.3): `?preview=<id>` on the page's
 * URL, its other parameters kept. Opening it adds a history entry, so Back
 * closes it; moving between files replaces it, so Back still closes it; and
 * a reload keeps it open.
 */
export function usePreview() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const state = location.state as PreviewState | null
  const previewId = searchParams.get('preview')

  function withPreview(id: string | null): URLSearchParams {
    const next = new URLSearchParams(searchParams)
    if (id === null) next.delete('preview')
    else next.set('preview', id)
    return next
  }

  return {
    previewId,
    open: (id: string) => {
      setSearchParams(withPreview(id), { state: { preview: true } satisfies PreviewState })
    },
    move: (id: string) => {
      setSearchParams(withPreview(id), { replace: true, state })
    },
    close: () => {
      if (state?.preview) void navigate(-1)
      else setSearchParams(withPreview(null), { replace: true })
    },
  }
}
