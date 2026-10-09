import type { PublicShare, SharedNode } from '@dfs/shared'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  ChevronRight,
  Download,
  FileArchive,
  Info,
  Link2Off,
  Lock,
  Play,
  TriangleAlert,
} from 'lucide-react'
import { Fragment, useActionState, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { AppLogo } from '@/components/app-logo'
import { AudioBar } from '@/features/audio/audio-bar'
import { playTracks } from '@/features/audio/engine'
import { audioQuery, isAudio, openAudio } from '@/features/audio/open-audio'
import { ListSkeleton } from '@/components/list-skeleton'
import { NodeIcon } from '@/components/node-icon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { VirtualList } from '@/components/virtual-list'
import { MediaDetails } from '@/features/player/media-details'
import { FileDetails } from '@/features/preview/file-viewer'
import { handlePreviewKey } from '@/features/preview/keys'
import { PreviewBody } from '@/features/preview/preview-body'
import { usePreview } from '@/features/preview/use-preview'
import type { ViewHandle } from '@/features/preview/view-handle'
import { ThemeMenu } from '@/layout/theme-menu'
import { ApiError, errorMessage } from '@/lib/api/client'
import { linkPlace, type FilePlace } from '@/lib/file-place'
import { formatBytes, formatDate, formatFullDate } from '@/lib/format'
import { formText } from '@/lib/form-data'
import { transitionLinkProps } from '@/lib/navigation'
import { isPreviewable, previewKind } from '@/lib/preview-kind'
import { cn } from '@/lib/utils'
import {
  downloadSharedFile,
  downloadSharedFolder,
  publicShareQuery,
  sharedFolderQuery,
  useUnlockShare,
} from './api'
import { SharePreview } from './share-preview'

const ROW_HEIGHT = 44

type OpenShare = Extract<PublicShare, { locked: false }>

/**
 * `/s/:token`: what someone with a share link sees, signed in or not (§10.1).
 * A password prompt if the link has one, then the file, previewed when it
 * can be (§10.3), or the folder to browse, its files opening in the viewer,
 * with downloads of single files and ZIPs of folders.
 */
export function SharePage() {
  const { token = '' } = useParams()
  const share = useQuery(publicShareQuery(token))

  let content: ReactNode
  if (share.isPending) {
    content = (
      <div className="flex flex-1 items-center justify-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    )
  } else if (share.isError) {
    content = <Unavailable error={share.error} />
  } else if (share.data.locked) {
    content = <PasswordGate token={token} />
  } else if (share.data.root.kind === 'file') {
    content = <SharedFile token={token} share={share.data} file={share.data.root} />
  } else {
    content = <SharedFolder token={token} share={share.data} />
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <title>
        {share.data && !share.data.locked ? `${share.data.root.name} – DFS` : 'Shared link – DFS'}
      </title>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <AppLogo withName />
        <span className="hidden text-sm text-muted-foreground sm:inline">Shared link</span>
        <div className="ml-auto">
          <ThemeMenu />
        </div>
      </header>
      {/* Named for View Transitions, like the app's content pane. */}
      <main className="flex min-h-0 flex-1 flex-col [view-transition-name:page]">{content}</main>
      <AudioBar />
    </div>
  )
}

// ── States ───────────────────────────────────────────────────────────────────

const UNAVAILABLE: Record<string, { title: string; description: string }> = {
  share_expired: {
    title: 'This link has expired',
    description: 'Ask the person who shared it for a new one.',
  },
  share_used_up: {
    title: 'This link has been used up',
    description: 'It reached its download limit. Ask the person who shared it for a new one.',
  },
  share_version_deleted: {
    title: 'This version is gone',
    description:
      'The file was replaced, and the version this link shared was deleted. Ask the person who shared it for a new link.',
  },
  share_not_found: {
    title: 'This link doesn’t exist',
    description:
      'Check that you copied all of it. The person who shared it may also have turned it off.',
  },
}

function Unavailable({ error }: { error: Error }) {
  const known = error instanceof ApiError ? UNAVAILABLE[error.code] : undefined
  return (
    <Centered>
      <span className="flex size-12 animate-in items-center justify-center rounded-full bg-muted zoom-in-50 motion-bounce">
        {known ? (
          <Link2Off className="size-5 text-muted-foreground" />
        ) : (
          <TriangleAlert className="size-5 text-destructive" />
        )}
      </span>
      <h1 className="text-lg font-semibold">{known?.title ?? 'Couldn’t open this link'}</h1>
      <p className="text-sm text-muted-foreground">{known?.description ?? error.message}</p>
    </Centered>
  )
}

interface GateState {
  error: string | null
  /** Bumped per wrong password, to shake the card again. */
  attempt: number
}

/** The password prompt. A wrong password shakes the card and clears the field, as on iOS. */
function PasswordGate({ token }: { token: string }) {
  const unlock = useUnlockShare(token)
  const [state, submit, pending] = useActionState(
    async (previous: GateState, formData: FormData): Promise<GateState> => {
      const password = formText(formData, 'password')
      if (!password) return { ...previous, error: 'Enter the password.' }
      try {
        await unlock.mutateAsync(password)
        return previous
      } catch (error) {
        return { error: errorMessage(error), attempt: previous.attempt + 1 }
      }
    },
    { error: null, attempt: 0 },
  )

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <form
        key={state.attempt}
        action={submit}
        className={cn(
          'grid w-full max-w-sm justify-items-center gap-4 rounded-xl border bg-card p-6 text-center shadow-sm',
          state.attempt === 0
            ? 'animate-in fade-in-0 zoom-in-95 motion-spring'
            : 'animate-[shake_420ms_var(--ease-smooth)]',
        )}
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-primary/15">
          <Lock className="size-5 text-primary" aria-hidden />
        </span>
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold">This link is protected</h1>
          <p className="text-sm text-muted-foreground">Enter the password you were given.</p>
        </div>
        <div className="grid w-full gap-2 text-left">
          <Label htmlFor="share-password" className="sr-only">
            Password
          </Label>
          <Input
            id="share-password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            aria-invalid={state.error !== null}
            placeholder="Password"
          />
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending && <Spinner />} Open
        </Button>
      </form>
    </div>
  )
}

function SharedFile({ token, share, file }: { token: string; share: OpenShare; file: SharedNode }) {
  const [downloading, setDownloading] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const previewable = isPreviewable(file)
  const place = linkPlace(token, file.id)
  // A video's Details hold what its header doesn't: its formats, and the connection test.
  const video = previewKind(file.name, file.mimeType) === 'video'

  async function download() {
    setDownloading(true)
    try {
      await downloadSharedFile(token, file)
    } catch (error) {
      toast.error('Couldn’t download', { description: errorMessage(error) })
    } finally {
      setDownloading(false)
    }
  }

  const downloadButton = (large: boolean) => (
    <Button
      size={large ? 'lg' : 'default'}
      className={large ? 'px-6' : undefined}
      disabled={downloading}
      onClick={() => void download()}
    >
      {downloading ? <Spinner /> : <Download />} Download
    </Button>
  )

  if (previewable) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
          <NodeIcon node={file} className="size-6 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-semibold" title={file.name}>
              {file.name}
            </h1>
            <ShareFacts
              share={share}
              lead={`${formatBytes(file.sizeBytes)} · modified ${formatDate(file.updatedAt)}`}
            />
          </div>
          {video && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Details"
              aria-expanded={detailsOpen}
              onClick={() => {
                setDetailsOpen(!detailsOpen)
              }}
            >
              <Info />
            </Button>
          )}
          {downloadButton(false)}
        </div>
        <InlinePreview
          file={file}
          place={place}
          details={
            video && detailsOpen ? (
              <FileDetails file={file} media={<MediaDetails place={place} />} />
            ) : null
          }
          onCloseDetails={() => {
            setDetailsOpen(false)
          }}
          onDownload={() => void download()}
        />
      </div>
    )
  }

  return (
    <Centered>
      <NodeIcon node={file} className="size-16 animate-in zoom-in-50 motion-bounce" />
      <div className="grid gap-1">
        <h1 className="text-lg font-semibold break-all">{file.name}</h1>
        <p className="text-sm text-muted-foreground tabular-nums">
          {formatBytes(file.sizeBytes)} · modified {formatDate(file.updatedAt)}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {isAudio(file) && (
          <Button
            size="lg"
            variant="outline"
            className="px-6"
            onClick={() => {
              openAudio({ ...file, parentId: null }, token)
            }}
          >
            <Play /> Play
          </Button>
        )}
        {downloadButton(true)}
      </div>
      <ShareFacts share={share} />
    </Centered>
  )
}

/** A file link's preview, under its name and Download: dark, as in the viewer, with its Details over it. */
function InlinePreview({
  file,
  place,
  details,
  onCloseDetails,
  onDownload,
}: {
  file: SharedNode
  place: FilePlace
  details: ReactNode
  onCloseDetails: () => void
  onDownload: () => void
}) {
  const frame = useRef<HTMLDivElement>(null)
  const view = useRef<ViewHandle>(null)
  // The keys are the preview's: + − 0 zoom, Ctrl+F searches text.
  useEffect(() => {
    frame.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div
      ref={frame}
      tabIndex={-1}
      className="dark relative min-h-0 flex-1 bg-neutral-950 text-foreground outline-none"
      onKeyDown={(event) => {
        // Esc closes Details, as in the viewer.
        if (event.key === 'Escape' && details) {
          onCloseDetails()
          return
        }
        handlePreviewKey(event, view.current, null, null)
      }}
    >
      <PreviewBody
        file={file}
        error={null}
        place={place}
        view={view}
        previous={null}
        next={null}
        onDownload={onDownload}
      />
      {details}
    </div>
  )
}

// ── Folders ──────────────────────────────────────────────────────────────────

function SharedFolder({ token, share }: { token: string; share: OpenShare }) {
  const [searchParams] = useSearchParams()
  const preview = usePreview()
  const folderId = searchParams.get('folder')
  const listing = useInfiniteQuery(sharedFolderQuery(token, folderId))
  const nodes = listing.data?.pages.flatMap((page) => page.items) ?? []
  const path = listing.data?.pages[0]?.path ?? [{ id: share.root.id, name: share.root.name }]
  const current = path.at(-1) ?? share.root
  const isRoot = folderId === null
  // Its audio, everything below it, ready to play at a click (§10.4).
  const audio = useQuery(audioQuery(current.id, token, true)).data

  const folderUrl = (id: string) =>
    id === share.root.id ? `/s/${token}` : `/s/${token}?folder=${id}`

  function downloadFolder() {
    toast.promise(downloadSharedFolder(token, current, isRoot), {
      loading: 'Preparing the ZIP…',
      success: 'Download started',
      error: (error: unknown) => ({
        message: 'Couldn’t download',
        description: errorMessage(error),
      }),
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2">
        {/* On a phone, the path has a row of its own, and the buttons wrap below it. */}
        <nav aria-label="Folder path" className="min-w-0 flex-1 max-sm:basis-full">
          <ol className="flex min-w-0 items-center gap-0.5 text-sm">
            {path.map((entry, index) => (
              <Fragment key={entry.id}>
                {index > 0 && (
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
                )}
                <li
                  className={cn(
                    'min-w-0',
                    // The folder you are in first; the path above takes the rest.
                    index === path.length - 1 && 'max-w-[70%] shrink-0',
                  )}
                >
                  <Link
                    to={folderUrl(entry.id)}
                    {...transitionLinkProps('back')}
                    aria-current={index === path.length - 1 ? 'page' : undefined}
                    className={cn(
                      'block truncate rounded-md px-1.5 py-1 hover:bg-muted',
                      index === path.length - 1
                        ? 'text-base font-semibold'
                        : 'text-muted-foreground',
                    )}
                  >
                    {entry.name}
                  </Link>
                </li>
              </Fragment>
            ))}
          </ol>
          <ShareFacts share={share} className="px-1.5" />
        </nav>
        {audio && audio.items.length > 0 && (
          <Button
            variant="outline"
            onClick={() => {
              playTracks(audio.items)
            }}
          >
            <Play /> Play {isRoot ? 'all' : 'folder'}
          </Button>
        )}
        <Button variant="outline" onClick={downloadFolder}>
          <FileArchive /> Download {isRoot ? 'all' : 'folder'}
        </Button>
      </div>

      {listing.isPending ? (
        <ListSkeleton />
      ) : listing.isError ? (
        <Centered>
          <p className="text-sm text-muted-foreground">{errorMessage(listing.error)}</p>
          <Button variant="outline" asChild>
            <Link to={`/s/${token}`}>Back to the shared folder</Link>
          </Button>
        </Centered>
      ) : nodes.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">This folder is empty.</p>
      ) : (
        <VirtualList
          // A new list per folder, so it eases in as you go deeper.
          key={folderId ?? 'root'}
          role="list"
          aria-label={`Contents of ${current.name}`}
          className="flex-1 animate-in py-1 fade-in-0 motion-glide"
          items={nodes}
          getKey={(node) => node.id}
          itemHeight={ROW_HEIGHT}
          animateMoves
          onEndReached={
            listing.hasNextPage && !listing.isFetchingNextPage
              ? () => void listing.fetchNextPage()
              : undefined
          }
          renderItem={(node) => (
            <SharedRow
              token={token}
              node={node}
              url={folderUrl(node.id)}
              onPreview={
                isAudio(node)
                  ? () => {
                      openAudio(node, token)
                    }
                  : isPreviewable(node)
                    ? () => {
                        preview.open(node.id)
                      }
                    : undefined
              }
            />
          )}
        />
      )}
      <SharePreview
        token={token}
        nodes={nodes}
        loaded={listing.isSuccess}
        hasMore={listing.hasNextPage}
        isLoadingMore={listing.isFetchingNextPage}
        onLoadMore={() => void listing.fetchNextPage()}
      />
    </div>
  )
}

function SharedRow({
  token,
  node,
  url,
  onPreview,
}: {
  token: string
  node: SharedNode
  url: string
  /** Opens the file in the viewer, if it can show it. */
  onPreview?: () => void
}) {
  const name = (
    <span className="flex min-w-0 items-center gap-3">
      <NodeIcon node={node} className="size-5 shrink-0" />
      <span className="truncate" title={node.name}>
        {node.name}
      </span>
    </span>
  )

  return (
    <div
      role="listitem"
      className="mx-2 grid h-full grid-cols-[minmax(0,1fr)_2.25rem] items-center gap-4 rounded-md px-3 text-sm hover:bg-muted/60 sm:grid-cols-[minmax(0,1fr)_9.5rem_5.5rem_2.25rem]"
    >
      {node.kind === 'folder' ? (
        <Link
          to={url}
          {...transitionLinkProps('forward')}
          className="min-w-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {name}
        </Link>
      ) : onPreview ? (
        <button
          type="button"
          className="min-w-0 rounded text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onPreview}
        >
          {name}
        </button>
      ) : (
        name
      )}
      <span
        className="hidden truncate text-muted-foreground sm:block"
        title={formatFullDate(node.updatedAt)}
      >
        {formatDate(node.updatedAt)}
      </span>
      <span className="hidden text-right text-muted-foreground tabular-nums sm:block">
        {node.kind === 'folder' && node.sizeBytes === 0 ? '—' : formatBytes(node.sizeBytes)}
      </span>
      {node.kind === 'file' ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Download ${node.name}`}
          title="Download"
          onClick={() => {
            downloadSharedFile(token, node).catch((error: unknown) => {
              toast.error('Couldn’t download', { description: errorMessage(error) })
            })
          }}
        >
          <Download />
        </Button>
      ) : (
        <ChevronRight className="mx-auto size-4 text-muted-foreground" aria-hidden />
      )}
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** Who shared it, until when, and how many downloads are left; `lead` comes first. */
function ShareFacts({
  share,
  lead,
  className,
}: {
  share: OpenShare
  lead?: string
  className?: string
}) {
  const facts = lead ? [lead, `shared by ${share.sharedBy}`] : [`Shared by ${share.sharedBy}`]
  if (share.expiresAt) facts.push(`until ${formatFullDate(share.expiresAt)}`)
  if (share.downloadsLeft !== null) {
    facts.push(`${share.downloadsLeft} download${share.downloadsLeft === 1 ? '' : 's'} left`)
  }
  return <p className={cn('text-xs text-muted-foreground', className)}>{facts.join(' · ')}</p>
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <div className="grid w-full max-w-md animate-in justify-items-center gap-4 rounded-xl border bg-card p-8 text-center shadow-sm fade-in-0 zoom-in-95 motion-spring">
        {children}
      </div>
    </div>
  )
}
