import { splitExtension, type DriveNode } from '@dfs/shared'

// Which viewer shows a file (DESIGN.md §10.3): only files the browser can
// draw open in one; the rest download, as before previews.

export type PreviewKind = 'image' | 'text'

/** How a text file is shown: Markdown formatted, JSON pretty-printed, the rest as it is. */
export type TextFormat = 'markdown' | 'json' | 'plain'

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

// An SVG isn't here: without its type the browser won't draw one, and a
// file uploaded without a type is sent without one. Its source shows instead.
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

/** Text that isn't `text/*`. */
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/typescript',
  'application/x-typescript',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-csh',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/sql',
  'application/graphql',
  'application/x-ndjson',
  'application/x-httpd-php',
  'application/x-subrip',
  'application/x-tex',
])

const TEXT_EXTENSIONS = new Set(
  (
    '.txt .text .md .markdown .mdx .log .csv .tsv .json .jsonc .json5 .ndjson .geojson ' +
    '.yaml .yml .toml .ini .cfg .conf .properties .env .xml .xsd .xsl .svg .html .htm .xhtml ' +
    '.css .scss .sass .less .js .mjs .cjs .jsx .ts .mts .cts .tsx .vue .svelte .astro ' +
    '.py .pyi .rb .go .rs .java .kt .kts .scala .groovy .gradle .c .h .cc .cpp .cxx .hpp .hh ' +
    '.m .mm .cs .fs .swift .php .pl .pm .lua .r .dart .ex .exs .erl .hs .clj .elm .jl .nim ' +
    '.zig .sh .bash .zsh .fish .ps1 .psm1 .bat .cmd .sql .graphql .gql .proto .tf .hcl ' +
    '.dockerfile .diff .patch .srt .vtt .tex .bib .rst .adoc .org .lock'
  ).split(' '),
)

/** Text files known by their whole name, many of them without an extension. */
const TEXT_NAMES = new Set([
  'dockerfile',
  'makefile',
  'license',
  'licence',
  'readme',
  'changelog',
  'authors',
  'contributing',
  'notice',
  'copying',
  'procfile',
  'gemfile',
  'rakefile',
  'vagrantfile',
  'jenkinsfile',
  'caddyfile',
  '.gitignore',
  '.gitattributes',
  '.dockerignore',
  '.editorconfig',
  '.env',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.prettierignore',
  '.eslintrc',
  '.babelrc',
  '.bashrc',
  '.zshrc',
  '.profile',
])

/**
 * How a file is previewed, or `null` when it isn't: by its MIME type when
 * the upload gave an image or text one, else by its name. Browsers give some
 * code a wrong type (`video/mp2t` for TypeScript, on Windows), so a type that
 * is neither defers to the name.
 */
export function previewKind(
  name: string,
  mimeType: string | null,
  support: PreviewSupport = browserSupport,
): PreviewKind | null {
  const type = baseType(mimeType)
  if (type?.startsWith('image/')) {
    return IMAGE_TYPES.has(type) || (support.appleImages && APPLE_IMAGE_TYPES.has(type))
      ? 'image'
      : null
  }
  if (type && isTextType(type)) return 'text'
  const extension = splitExtension(name).extension.toLowerCase()
  if (
    IMAGE_EXTENSIONS.has(extension) ||
    (support.appleImages && APPLE_IMAGE_EXTENSIONS.has(extension))
  )
    return 'image'
  if (TEXT_EXTENSIONS.has(extension) || TEXT_NAMES.has(name.toLowerCase())) return 'text'
  return null
}

/** How a text file is shown (§10.3). */
export function textFormat(name: string, mimeType: string | null): TextFormat {
  const type = baseType(mimeType)
  const extension = splitExtension(name).extension.toLowerCase()
  if (type === 'text/markdown' || ['.md', '.markdown', '.mdx'].includes(extension))
    return 'markdown'
  if (
    type === 'application/json' ||
    type?.endsWith('+json') ||
    ['.json', '.geojson'].includes(extension)
  )
    return 'json'
  return 'plain'
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

/** `text/html; charset=utf-8` → `text/html`; nothing for none, or one that says nothing. */
function baseType(mimeType: string | null): string | null {
  const type = mimeType?.split(';')[0]?.trim().toLowerCase()
  return type && type !== 'application/octet-stream' ? type : null
}

function isTextType(type: string): boolean {
  return (
    (type.startsWith('text/') && type !== 'text/rtf') ||
    TEXT_TYPES.has(type) ||
    type.endsWith('+json') ||
    type.endsWith('+xml')
  )
}

const browserSupport: PreviewSupport = supportOf(
  typeof navigator === 'undefined' ? '' : navigator.userAgent,
)
