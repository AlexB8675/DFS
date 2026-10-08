import { MEDIA_EXTENSION_KINDS } from './media.ts'
import { splitExtension } from './names.ts'

// What kind of file a name and MIME type suggest: for icons in the web app
// and the usage breakdown of the admin pages (DESIGN.md §10.1).

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
  // Audio and video as the players know them.
  ...MEDIA_EXTENSION_KINDS,
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
