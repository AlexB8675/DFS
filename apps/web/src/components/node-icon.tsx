import type { DriveNode } from '@dfs/shared'
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import { fileCategory, type FileCategory } from '@/lib/file-types'
import { cn } from '@/lib/utils'

const CATEGORY_ICONS: Record<FileCategory, { icon: LucideIcon; className: string }> = {
  image: { icon: FileImage, className: 'text-emerald-700 dark:text-emerald-500' },
  video: { icon: FileVideo, className: 'text-rose-600 dark:text-rose-500' },
  audio: { icon: FileAudio, className: 'text-violet-500' },
  pdf: { icon: FileText, className: 'text-red-600 dark:text-red-500' },
  archive: { icon: FileArchive, className: 'text-amber-700 dark:text-amber-500' },
  code: { icon: FileCode, className: 'text-sky-600 dark:text-sky-500' },
  text: { icon: FileText, className: 'text-slate-500 dark:text-slate-400' },
  spreadsheet: { icon: FileSpreadsheet, className: 'text-green-700 dark:text-green-500' },
  presentation: { icon: Presentation, className: 'text-orange-700 dark:text-orange-500' },
  document: { icon: FileText, className: 'text-blue-600 dark:text-blue-500' },
  other: { icon: File, className: 'text-muted-foreground' },
}

interface NodeIconProps {
  node: Pick<DriveNode, 'kind' | 'name' | 'mimeType'>
  className?: string
}

/** A folder, or a file icon colored by file type. */
export function NodeIcon({ node, className }: NodeIconProps) {
  if (node.kind === 'folder') {
    return (
      <Folder
        className={cn(
          'fill-sky-600/25 text-sky-600 dark:fill-sky-500/25 dark:text-sky-500',
          className,
        )}
        aria-hidden
      />
    )
  }
  const { icon: Icon, className: color } = CATEGORY_ICONS[fileCategory(node.name, node.mimeType)]
  return <Icon className={cn(color, className)} aria-hidden />
}
