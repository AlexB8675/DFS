import { Download, FileX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'

/** Shown when the viewer can't show the file. */
export function NoPreview({
  title,
  description,
  onDownload,
}: {
  title: string
  description: string
  onDownload?: () => void
}) {
  return (
    <Empty className="size-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileX />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {onDownload && (
        <EmptyContent>
          <Button onClick={onDownload}>
            <Download /> Download
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
}
