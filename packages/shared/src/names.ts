/** Longest allowed file or folder name, in UTF-16 code units. */
export const MAX_NAME_LENGTH = 255

/** Normalizes user input into a stored name: Unicode NFC, outer whitespace removed. */
export function normalizeName(raw: string): string {
  return raw.normalize('NFC').trim()
}

/**
 * Key used for the per-folder uniqueness check (DESIGN.md §5.1), so that
 * `Photo.JPG` and `photo.jpg` cannot sit side by side.
 */
export function nameKey(name: string): string {
  return normalizeName(name).toLowerCase()
}

/** Returns a human-readable problem with `name`, or `null` if it is valid. */
export function validateName(name: string): string | null {
  if (name.length === 0) return 'Enter a name.'
  if (name.length > MAX_NAME_LENGTH) return `Names can be at most ${MAX_NAME_LENGTH} characters.`
  if (name === '.' || name === '..') return 'This name is reserved.'
  if (name.includes('/') || name.includes('\\')) return 'Names cannot contain / or \\.'
  if (hasControlCharacter(name)) return 'Names cannot contain control characters.'
  return null
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Splits `report.final.pdf` into `report.final` and `.pdf`. Dotfiles have no extension. */
export function splitExtension(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return { base: name, extension: '' }
  return { base: name.slice(0, dot), extension: name.slice(dot) }
}
