// Reading a file as text for the viewer (DESIGN.md §10.3): its first bytes
// decoded, or found to be binary, and JSON laid out without changing it.

/** How much of a file the viewer reads: a log larger than this shows its start. */
export const TEXT_CAP = 5 * 1024 * 1024

export type DecodedText = { binary: false; text: string } | { binary: true }

/**
 * The bytes as text: UTF-8, or UTF-16 when a byte-order mark says so (the
 * mark itself left out). `cut` says the bytes stop at the cap, perhaps in
 * the middle of a character, which is then left out too. Text with a NUL
 * byte, or mostly not UTF-8, is binary.
 */
export function decodeText(bytes: Uint8Array, cut: boolean): DecodedText {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8'
  if (encoding === 'utf-8' && bytes.includes(0)) return { binary: true }
  // `stream` keeps a character cut at the end back, waiting for bytes that never come.
  const text = new TextDecoder(encoding).decode(bytes, { stream: cut })
  const bad = encoding === 'utf-8' ? unreadable(text) : 0
  if (bad > 1 && bad > text.length / 10) return { binary: true }
  return { binary: false, text }
}

/** How many characters weren't UTF-8. */
function unreadable(text: string): number {
  let count = 0
  for (let index = text.indexOf('\uFFFD'); index !== -1; index = text.indexOf('\uFFFD', index + 1))
    count += 1
  return count
}

/**
 * JSON laid out two spaces to a level, or `null` when it isn't JSON. Only
 * the spaces between tokens change: a number keeps every digit, which
 * `JSON.stringify(JSON.parse(…))` would round past 2⁵³.
 */
export function formatJson(text: string): string | null {
  try {
    JSON.parse(text)
  } catch {
    return null
  }
  const out: string[] = []
  let depth = 0
  const newline = () => `\n${'  '.repeat(depth)}`
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    switch (char) {
      case '"': {
        // A string, escapes and all, as it is.
        let end = index + 1
        while (end < text.length && text.charAt(end) !== '"')
          end += text.charAt(end) === '\\' ? 2 : 1
        out.push(text.slice(index, end + 1))
        index = end
        break
      }
      case '{':
      case '[': {
        const close = char === '{' ? '}' : ']'
        let next = index + 1
        while (/\s/.test(text.charAt(next))) next += 1
        // An empty one stays as it is.
        if (text.charAt(next) === close) {
          out.push(char + close)
          index = next
        } else {
          depth += 1
          out.push(char + newline())
        }
        break
      }
      case '}':
      case ']':
        depth -= 1
        out.push(newline() + char)
        break
      case ',':
        out.push(`,${newline()}`)
        break
      case ':':
        out.push(': ')
        break
      case ' ':
      case '\t':
      case '\n':
      case '\r':
        break
      default:
        out.push(char)
    }
  }
  return out.join('')
}
