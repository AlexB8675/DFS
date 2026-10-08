import { Minus, MoveHorizontal, Plus } from 'lucide-react'
import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  InvalidPDFException,
  PasswordException,
  PDFDataRangeTransport,
  version,
  type PDFDocumentLoadingTask,
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { NoPreview } from './no-preview'
import type { ViewHandle } from './view-handle'

GlobalWorkerOptions.workerSrc = workerUrl

/** pdf.js's data files, as pdfjs-assets.ts serves them. */
const ASSETS = `/assets/pdfjs-${version}/`

/** pdf.js's zooms that follow the window's size. */
const FITTING = new Set(['auto', 'page-width', 'page-fit'])

/** The first read: pdf.js's chunk size, which gives the file's length too. */
const FIRST_BYTES = 64 * 1024

/** The file's first bytes, its length, and its version's ETag (§6.2). */
interface FirstRead {
  bytes: Uint8Array
  length: number
  etag: string
}

/**
 * pdf.js's reads, each a Range request made here. Given a URL, pdf.js would
 * first ask for the whole file and drop the request once it had seen the
 * headers, which costs the API chunks read from Discord for nobody. Each
 * names the version the first read found (`If-Range`): another would come
 * whole, and is refused rather than mixed with it.
 */
class RangeReader extends PDFDataRangeTransport {
  readonly #url: string
  readonly #etag: string
  readonly #signal: AbortSignal
  readonly #onError: () => void

  constructor(url: string, first: FirstRead, signal: AbortSignal, onError: () => void) {
    super(first.length, first.bytes)
    this.#url = url
    this.#etag = first.etag
    this.#signal = signal
    this.#onError = onError
  }

  override requestDataRange(begin: number, end: number): void {
    this.#read(begin, end).catch(() => {
      if (!this.#signal.aborted) this.#onError()
    })
  }

  async #read(begin: number, end: number): Promise<void> {
    const response = await fetch(this.#url, {
      headers: { Range: `bytes=${String(begin)}-${String(end - 1)}`, 'If-Range': this.#etag },
      signal: this.#signal,
    })
    if (response.status !== 206) {
      void response.body?.cancel()
      throw new Error('The file changed while it was open.')
    }
    this.onDataRange(begin, new Uint8Array(await response.arrayBuffer()))
  }
}

/** The first bytes; `null` for an empty file, which has none. */
async function readFirst(url: string, signal: AbortSignal): Promise<FirstRead | null> {
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${String(FIRST_BYTES - 1)}` },
    signal,
  })
  if (response.status === 416) return null
  if (!response.ok) throw new Error(`The file couldn’t be read (${String(response.status)}).`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const total = /\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')?.[1]
  return {
    bytes,
    // All of it, when the server sent it whole.
    length: total === undefined ? bytes.length : Number(total),
    etag: response.headers.get('ETag') ?? '',
  }
}

interface PdfViewProps {
  /** Where its bytes are, as an API path. */
  contentPath: string
  onDownload: () => void
  ref?: Ref<ViewHandle>
}

type Status = 'loading' | 'ready' | 'locked' | 'damaged' | 'failed'

/**
 * A PDF in the viewer (§10.3), drawn by pdf.js: pages as they scroll into
 * view, with text that can be selected, zoom and the page count. It reads
 * the file with Range requests, so a large one opens at its first pages.
 */
export default function PdfView({ contentPath, onDownload, ref }: PdfViewProps) {
  const container = useRef<HTMLDivElement>(null)
  const viewer = useRef<PDFViewer | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [pages, setPages] = useState(0)
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const element = container.current
    if (!element) return
    const eventBus = new EventBus()
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: 'noopener noreferrer nofollow',
    })
    const pdfViewer = new PDFViewer({
      container: element,
      eventBus,
      linkService,
      // Links and notes, but forms as they are: this is a viewer.
      annotationMode: AnnotationMode.ENABLE,
    })
    linkService.setViewer(pdfViewer)
    viewer.current = pdfViewer
    eventBus.on('pagesinit', () => {
      pdfViewer.currentScaleValue = 'auto'
    })
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      setPage(pageNumber)
    })
    eventBus.on('scalechanging', ({ scale: next }: { scale: number }) => {
      setScale(next)
    })

    const url = `/api${contentPath}`
    const stop = new AbortController()
    let task: PDFDocumentLoadingTask | null = null
    const open = async () => {
      const first = await readFirst(url, stop.signal)
      if (!first) {
        setStatus('damaged')
        return
      }
      if (stop.signal.aborted) return
      task = getDocument({
        range: new RangeReader(url, first, stop.signal, () => {
          setStatus('failed')
        }),
        cMapUrl: `${ASSETS}cmaps/`,
        standardFontDataUrl: `${ASSETS}standard_fonts/`,
        // The CSP allows no WebAssembly: pdf.js's JavaScript decoders, from here.
        wasmUrl: `${ASSETS}wasm/`,
        useWasm: false,
        // Only the ranges the pages on screen need, in pdf.js's 64 KiB chunks:
        // it reads every page's dictionary when it opens a file, and larger
        // chunks would read the pages around them too, often the whole file.
        disableAutoFetch: true,
      })
      const pdf = await task.promise
      pdfViewer.setDocument(pdf)
      linkService.setDocument(pdf)
      setPages(pdf.numPages)
      setStatus('ready')
      // Its own keys: arrows and space scroll it, ← and → still move on.
      element.focus({ preventScroll: true })
    }
    open().catch((error: unknown) => {
      if (stop.signal.aborted) return
      if (error instanceof PasswordException) setStatus('locked')
      else if (error instanceof InvalidPDFException) setStatus('damaged')
      else setStatus('failed')
    })

    // Ctrl and the wheel, or a trackpad's pinch, zoom around the pointer.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      pdfViewer.updateScale({
        steps: event.deltaY < 0 ? 1 : -1,
        origin: [event.clientX, event.clientY],
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })

    // A zoom that fits the window fits it again when the window changes.
    const resize = new ResizeObserver(() => {
      const value = pdfViewer.currentScaleValue
      if (pdfViewer.pagesCount > 0 && FITTING.has(value)) pdfViewer.currentScaleValue = value
    })
    resize.observe(element)

    return () => {
      resize.disconnect()
      element.removeEventListener('wheel', onWheel)
      viewer.current = null
      pdfViewer.setDocument(null)
      linkService.setDocument(null)
      // The reads under way, and the document.
      stop.abort()
      void task?.destroy()
    }
  }, [contentPath])

  useImperativeHandle(ref, () => ({
    zoomIn: () => viewer.current?.increaseScale(),
    zoomOut: () => viewer.current?.decreaseScale(),
    reset: () => {
      if (viewer.current) viewer.current.currentScaleValue = 'auto'
    },
  }))

  const failure = {
    locked: {
      title: 'This PDF has a password',
      description: 'Download it to open it with its password.',
    },
    damaged: {
      title: 'No preview',
      description: 'This file isn’t a PDF that can be read: it may be damaged.',
    },
    failed: {
      title: 'This PDF couldn’t be loaded',
      description: 'Try again in a moment, or download it.',
    },
  }
  const shown = status === 'loading' || status === 'ready' ? null : failure[status]

  return (
    <div className="relative size-full">
      <div
        ref={container}
        tabIndex={-1}
        className="absolute inset-0 overflow-auto outline-none"
        aria-label="PDF pages"
      >
        <div className="pdfViewer" />
      </div>
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <Spinner className="size-6" />
        </div>
      )}
      {shown && (
        <div className="absolute inset-0 bg-neutral-950">
          <NoPreview title={shown.title} description={shown.description} onDownload={onDownload} />
        </div>
      )}
      {status === 'ready' && (
        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-xl bg-background/80 p-1 text-sm shadow-lg ring-1 ring-foreground/10 backdrop-blur-sm">
          <span className="px-2 whitespace-nowrap text-muted-foreground tabular-nums">
            Page {page} of {pages}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom out"
            onClick={() => viewer.current?.decreaseScale()}
          >
            <Minus />
          </Button>
          <span className="w-12 text-center tabular-nums">{Math.round(scale * 100)}%</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            onClick={() => viewer.current?.increaseScale()}
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fit the page width"
            title="Fit the page width"
            onClick={() => {
              if (viewer.current) viewer.current.currentScaleValue = 'page-width'
            }}
          >
            <MoveHorizontal />
          </Button>
        </div>
      )}
    </div>
  )
}
