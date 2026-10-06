/**
 * A browser's User-Agent in a few words, such as "Firefox on Windows", for
 * telling a person's sessions apart. Scripts show their first word.
 */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'An unknown device'
  if (!userAgent.startsWith('Mozilla/')) {
    const [product = ''] = userAgent.trim().split(/[\s/]/)
    return product === '' ? 'An unknown client' : product
  }
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'A browser'
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1]
  return system ? `${browser} on ${system}` : browser
}

/** In the order to test them: Edge and Opera say they are Chrome, and Chrome says it is Safari. */
const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/.*Safari\//, 'Safari'],
]

/** iPhones and iPads say "like Mac OS X", and Android says it is Linux. */
const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
]
