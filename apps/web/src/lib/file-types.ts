import { splitExtension } from '@dfs/shared'

export type FileCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'archive'
  | 'code'
  | 'text'
  | 'spreadsheet'
  | 'presentation'
  | 'document'
  | 'other'

// Used when the MIME type is missing, which browsers do for e.g. HEIC photos.
const EXTENSIONS: Record<string, FileCategory> = {
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.heic': 'image',
  '.avif': 'image',
  '.svg': 'image',
  '.mp4': 'video',
  '.mov': 'video',
  '.mkv': 'video',
  '.avi': 'video',
  '.webm': 'video',
  '.mp3': 'audio',
  '.flac': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.ogg': 'audio',
  '.pdf': 'pdf',
  '.zip': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.tgz': 'archive',
  '.xz': 'archive',
  '.ts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.json': 'code',
  '.css': 'code',
  '.html': 'code',
  '.py': 'code',
  '.rs': 'code',
  '.go': 'code',
  '.sh': 'code',
  '.yml': 'code',
  '.yaml': 'code',
  '.sql': 'code',
  '.md': 'text',
  '.txt': 'text',
  '.log': 'text',
  '.csv': 'spreadsheet',
  '.xlsx': 'spreadsheet',
  '.xls': 'spreadsheet',
  '.ods': 'spreadsheet',
  '.pptx': 'presentation',
  '.ppt': 'presentation',
  '.key': 'presentation',
  '.odp': 'presentation',
  '.docx': 'document',
  '.doc': 'document',
  '.odt': 'document',
  '.rtf': 'document',
}

/** Groups a file by MIME type first, then by extension. */
export function fileCategory(name: string, mimeType: string | null): FileCategory {
  if (mimeType?.startsWith('image/')) return 'image'
  if (mimeType?.startsWith('video/')) return 'video'
  if (mimeType?.startsWith('audio/')) return 'audio'
  if (mimeType === 'application/pdf') return 'pdf'

  const { extension } = splitExtension(name)
  return EXTENSIONS[extension.toLowerCase()] ?? (mimeType?.startsWith('text/') ? 'text' : 'other')
}

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
