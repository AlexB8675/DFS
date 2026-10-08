import { useQuery } from '@tanstack/react-query'
import { WrapText } from 'lucide-react'
import { lazy, Suspense, useState, type Ref } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ApiError, apiFetch, errorMessage } from '@/lib/api/client'
import { fileCategory } from '@/lib/file-types'
import { formatBytes } from '@/lib/format'
import { textFormat } from '@/lib/preview-kind'
import { CodeView } from './code-view'
import { rangeTotal } from './content-range'
import { NoPreview } from './no-preview'
import { decodeText, formatJson, TEXT_CAP, type DecodedText } from './text'
import type { ViewHandle } from './view-handle'

const MarkdownView = lazy(() => import('./markdown-view'))

interface TextViewProps {
  name: string
  mimeType: string | null
  sizeBytes: number
  /** Where its bytes are, as an API path. */
  contentPath: string
  onDownload: () => void
  ref?: Ref<ViewHandle>
}

/**
 * A text file in the viewer (§10.3): its first 5 MiB, decoded, in a
 * read-only editor; Markdown formatted and JSON laid out, each with a
 * switch to the file as it is.
 */
export default function TextView({
  name,
  mimeType,
  sizeBytes,
  contentPath,
  onDownload,
  ref,
}: TextViewProps) {
  const format = textFormat(name, mimeType)
  const [formatted, setFormatted] = useState(true)
  // Prose wraps; code keeps its lines.
  const [wrap, setWrap] = useState(fileCategory(name, mimeType) !== 'code')
  const content = useQuery({
    queryKey: ['preview', 'text', contentPath],
    queryFn: ({ signal }) => readText(contentPath, sizeBytes, signal),
    // Files are large: don't keep many around.
    gcTime: 30_000,
    retry: 1,
  })

  if (content.isPending) {
    return (
      <div className="flex size-full items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    )
  }
  if (content.isError) {
    return (
      <NoPreview
        title="This file couldn’t be loaded"
        description={errorMessage(content.error)}
        onDownload={onDownload}
      />
    )
  }
  const read = content.data
  if (read.binary) {
    return (
      <NoPreview
        title="No preview"
        description="This file isn’t text, whatever its name says."
        onDownload={onDownload}
      />
    )
  }

  const json = format === 'json' ? formatJson(read.text) : null
  const switchable = format === 'markdown' || json !== null
  const markdown = format === 'markdown' && formatted
  const text = json !== null && formatted ? json : read.text

  return (
    <div className="flex size-full flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs text-muted-foreground">
        {switchable && (
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            spacing={0}
            value={formatted ? 'formatted' : 'source'}
            onValueChange={(value) => {
              if (value) setFormatted(value === 'formatted')
            }}
            aria-label="Show"
          >
            <ToggleGroupItem value="formatted">Formatted</ToggleGroupItem>
            <ToggleGroupItem value="source">
              {format === 'markdown' ? 'Source' : 'As is'}
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        {read.cut && (
          <span>
            The first {formatBytes(TEXT_CAP)} of {formatBytes(read.size ?? sizeBytes)}.{' '}
            <Button variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onDownload}>
              Download it all
            </Button>
          </span>
        )}
        {!markdown && (
          <Toggle
            size="sm"
            className="ml-auto"
            pressed={wrap}
            onPressedChange={setWrap}
            aria-label="Wrap long lines"
            title="Wrap long lines"
          >
            <WrapText />
          </Toggle>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {markdown ? (
          <Suspense fallback={null}>
            <MarkdownView text={read.text} />
          </Suspense>
        ) : (
          <CodeView ref={ref} text={text} name={name} wrap={wrap} />
        )}
      </div>
    </div>
  )
}

type ReadText = DecodedText & {
  /** Only the first `TEXT_CAP` bytes were read. */
  cut: boolean
  /** The whole file's size, as the server said. */
  size?: number
}

/** The first `TEXT_CAP` bytes of a file, as text. */
async function readText(path: string, sizeBytes: number, signal: AbortSignal): Promise<ReadText> {
  if (sizeBytes === 0) return { binary: false, text: '', cut: false }
  let response: Response
  try {
    response = await apiFetch(path, {
      signal,
      headers: { Range: `bytes=0-${String(TEXT_CAP - 1)}` },
    })
  } catch (error) {
    // Empty after all: there is no byte 0 to start from.
    if (error instanceof ApiError && error.status === 416)
      return { binary: false, text: '', cut: false }
    throw error
  }
  const total = rangeTotal(response)
  let bytes = new Uint8Array(await response.arrayBuffer())
  // A server that sent all of it anyway: the start will do.
  if (bytes.length > TEXT_CAP) bytes = bytes.subarray(0, TEXT_CAP)
  const size = total ?? sizeBytes
  const cut = size > bytes.length
  return { ...decodeText(bytes, cut), cut, size }
}
