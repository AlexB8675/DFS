import { splitExtension, type DriveNode } from '@dfs/shared'

// Which viewer shows a file (DESIGN.md §10.3): only files the browser can
// draw open in one; the rest download, as before previews.

export type PreviewKind = 'image'

export interface PreviewSupport {
  /** HEIC, HEIF and TIFF photos, which only Apple's WebKit draws. */
  appleImages: boolean
}

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/pjpeg',
  'image/png',
  'image/apng',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-ms-bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
])
const APPLE_IMAGE_TYPES = new Set(['image/heic', 'image/heif', 'image/tiff'])

// An SVG is left out: without its type the browser won't draw one, and a
// file uploaded without a type is sent without one.
const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.jfif',
  '.png',
  '.apng',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.ico',
])
const APPLE_IMAGE_EXTENSIONS = new Set(['.heic', '.heif', '.tif', '.tiff'])

/**
 * How a file is previewed, or `null` when it isn't: by its MIME type when the
 * upload gave one, else by its extension.
 */
export function previewKind(
  name: string,
  mimeType: string | null,
  support: PreviewSupport = browserSupport,
): PreviewKind | null {
  const type = mimeType?.split(';')[0]?.trim().toLowerCase()
  if (type && type !== 'application/octet-stream') {
    if (IMAGE_TYPES.has(type) || (support.appleImages && APPLE_IMAGE_TYPES.has(type)))
      return 'image'
    return null
  }
  const extension = splitExtension(name).extension.toLowerCase()
  if (
    IMAGE_EXTENSIONS.has(extension) ||
    (support.appleImages && APPLE_IMAGE_EXTENSIONS.has(extension))
  )
    return 'image'
  return null
}

/** A file that opens in the viewer: one it can show, uploaded and readable. */
export function isPreviewable(node: DriveNode, support: PreviewSupport = browserSupport): boolean {
  return (
    node.kind === 'file' &&
    (node.syncState === 'syncing' || node.syncState === 'stored') &&
    previewKind(node.name, node.mimeType, support) !== null
  )
}

/**
 * What this browser draws. Every browser on an iPhone or iPad is WebKit, so
 * Chrome there says `CriOS`, not `Chrome/`.
 */
export function supportOf(userAgent: string): PreviewSupport {
  return {
    appleImages:
      userAgent.includes('AppleWebKit/') && !/(Chrome|Chromium|Android)\b/.test(userAgent),
  }
}

const browserSupport: PreviewSupport = supportOf(
  typeof navigator === 'undefined' ? '' : navigator.userAgent,
)
