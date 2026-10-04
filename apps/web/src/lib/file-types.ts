import type { FileCategory } from '@dfs/shared'

export { fileCategory, type FileCategory } from '@dfs/shared'

const CATEGORY_LABELS: Record<FileCategory, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  pdf: 'PDF document',
  archive: 'Archive',
  code: 'Source code',
  text: 'Text',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  document: 'Document',
  other: 'File',
}

export function fileCategoryLabel(category: FileCategory): string {
  return CATEGORY_LABELS[category]
}
