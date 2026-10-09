import { splitExtension } from '@dfs/shared'
import sampleVideoUrl from './sample-video.mp4?url'

// What the demo's files hold, made up per file, so previews (§10.3) and the
// player (§10.4) have something to show: the mock keeps no bytes but those
// uploaded to it, and one sample video (make-sample-video.sh), loaded when
// the mock starts.

export interface SampleFile {
  mimeType: string
  body: string
}

/**
 * An image, as an SVG whatever the file's name says: a landscape as large as
 * a phone's photo, or for an `.svg` a drawing with only a `viewBox`, so it
 * has no size of its own, like most icons. `null` for an image named
 * “(damaged)”, which no browser can draw.
 */
export function sampleImage(id: string, name: string): SampleFile | null {
  if (name.includes('(damaged)')) return null
  const random = seeded(id)
  const body =
    splitExtension(name).extension.toLowerCase() === '.svg'
      ? drawing(random)
      : landscape(random, name)
  return { mimeType: 'image/svg+xml', body }
}

function landscape(random: () => number, name: string): string {
  const portrait = random() < 0.25
  const [width, height] = portrait ? [3024, 4032] : [4032, 3024]
  const hue = Math.floor(random() * 360)
  const sky = `hsl(${hue} 70% 62%)`
  const glow = `hsl(${(hue + 40) % 360} 85% 78%)`
  const sun = { x: width * (0.2 + random() * 0.6), y: height * (0.2 + random() * 0.25) }
  const ridges = [0.55, 0.68, 0.8].map((level, index) => {
    const points = [`0,${height}`]
    for (let step = 0; step <= 8; step += 1) {
      const y = height * (level + (random() - 0.5) * 0.12)
      points.push(`${String(Math.round((width * step) / 8))},${String(Math.round(y))}`)
    }
    points.push(`${String(width)},${String(height)}`)
    const fill = `hsl(${(hue + 180 + index * 12) % 360} 35% ${String(38 - index * 10)}%)`
    return `<polygon points="${points.join(' ')}" fill="${fill}"/>`
  })
  const size = Math.round(width / 28)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}">`,
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="${glow}"/></linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="url(#sky)"/>`,
    `<circle cx="${String(Math.round(sun.x))}" cy="${String(Math.round(sun.y))}" r="${String(Math.round(width / 12))}" fill="hsl(48 100% 88%)" opacity="0.9"/>`,
    ...ridges,
    `<text x="${String(size)}" y="${String(height - size)}" font-family="system-ui, sans-serif" font-size="${String(size)}" fill="white" opacity="0.85">${escapeXml(name)}</text>`,
    '</svg>',
  ].join('')
}

function drawing(random: () => number): string {
  const hue = Math.floor(random() * 360)
  const shapes = Array.from({ length: 3 }, (_, index) => {
    const x = 4 + random() * 10
    const y = 4 + random() * 10
    const fill = `hsl(${(hue + index * 50) % 360} 70% 55%)`
    return index % 2 === 0
      ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(3 + random() * 4).toFixed(1)}" fill="${fill}"/>`
      : `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="8" height="8" rx="2" fill="${fill}"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${shapes.join('')}</svg>`
}

function escapeXml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] ?? char,
  )
}

/** The same numbers for the same file, every time (mulberry32 from an FNV-1a hash). */
function seeded(text: string): () => number {
  let state = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    state = Math.imul(state ^ text.charCodeAt(index), 0x01000193)
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const logs = new Map<string, string>()

/** Logs are made as large as they say, up to this: enough to pass the viewer's 5 MiB. */
const LOG_LIMIT = 8 * 1024 * 1024

let sampleVideoBytes: Uint8Array | null = null

/** Fetches the sample video, for every video in the demo; in the browser only. */
export async function loadSampleVideo(): Promise<void> {
  const response = await fetch(sampleVideoUrl)
  if (response.ok) sampleVideoBytes = new Uint8Array(await response.arrayBuffer())
}

/** What every video in the demo plays: 12 s of a test picture and a beep. */
export function sampleVideo(): Uint8Array | null {
  return sampleVideoBytes
}

/**
 * Text, by the file's kind: a Markdown page with GitHub's extras (and raw
 * HTML, which must not run), JSON with a number too large for a double,
 * code, prose, or a log as large as the file, to pass the viewer's cap.
 */
export function sampleText(id: string, name: string, sizeBytes: number): SampleFile {
  const extension = splitExtension(name).extension.toLowerCase()
  const random = seeded(id)
  switch (extension) {
    case '.md':
      return { mimeType: 'text/markdown', body: markdown(name) }
    case '.json':
      return { mimeType: 'application/json', body: json(name) }
    case '.log': {
      // Megabytes of it: made once, and kept for the next read.
      const body = logs.get(id) ?? log(random, Math.min(sizeBytes, LOG_LIMIT))
      logs.set(id, body)
      return { mimeType: 'text/plain', body }
    }
    case '.ts':
    case '.tsx':
      return { mimeType: 'text/x-typescript', body: typescript(name) }
    case '.yaml':
    case '.yml':
      return { mimeType: 'application/yaml', body: yaml() }
    case '.css':
      return { mimeType: 'text/css', body: css() }
    case '.html':
      return { mimeType: 'text/html', body: html(name) }
    case '.srt':
      return { mimeType: 'application/x-subrip', body: srt() }
    default:
      return { mimeType: 'text/plain', body: prose(random, name) }
  }
}

/** Subtitles for the sample video, in Italian, with italics. */
function srt(): string {
  return [
    '1',
    '00:00:01,000 --> 00:00:04,000',
    'Questi sottotitoli sono in un file accanto al video.',
    '',
    '2',
    '00:00:05,000 --> 00:00:08,500',
    '<i>Convertiti in WebVTT dal server.</i>',
    '',
    '3',
    '00:00:09,000 --> 00:00:11,500',
    'Scegli la lingua dal menu, o premi C.',
    '',
  ].join('\r\n')
}

function markdown(name: string): string {
  return [
    `# ${name.replace(/\.md$/i, '')}`,
    '',
    'Notes kept in **Markdown**, shown _formatted_ in the viewer, with a switch to the source.',
    '',
    '## This week',
    '',
    '- [x] Upload the photos from Lisbon',
    '- [x] Share the album with the family',
    '- [ ] Sort the 2023 folder',
    '',
    '| Day | Plan | Hours |',
    '| --- | --- | ---: |',
    '| Monday | Paperwork | 2 |',
    '| Tuesday | ~~Gym~~ Rest | 0 |',
    '',
    '> A quote, set apart.',
    '',
    'Some `inline code`, and a block:',
    '',
    '```ts',
    'const greeting = `Hello, ${name}!`',
    'console.log(greeting)',
    '```',
    '',
    'A link to [the project](https://github.com) opens in a new tab, and an image',
    'from elsewhere is not loaded: ![a diagram of the stack](https://example.com/stack.png)',
    '',
    'Raw HTML is left out: <script>alert("never runs")</script><b>not bold</b>',
    '',
    '---',
    '',
    'Last edited on a Sunday.',
    '',
  ].join('\n')
}

function json(name: string): string {
  return JSON.stringify({
    name: name.replace(/\.json$/i, ''),
    version: '1.4.0',
    private: true,
    scripts: { dev: 'vite', build: 'vite build', test: 'vitest run' },
    dependencies: { react: '^19.3.0', 'react-dom': '^19.3.0' },
    keywords: [],
    config: {},
  }).replace('"private":true', '"private":true,"snowflake":12345678901234567890')
}

function log(random: () => number, size: number): string {
  const levels = ['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR']
  const paths = ['/api/nodes', '/api/files/content', '/api/uploads', '/api/search', '/api/s/link']
  const lines: string[] = []
  let length = 0
  let time = Date.UTC(2026, 9, 1)
  while (length < size) {
    time += Math.floor(random() * 2000)
    const level = levels[Math.floor(random() * levels.length)] ?? 'INFO'
    const path = paths[Math.floor(random() * paths.length)] ?? '/api'
    const ms = Math.floor(random() * 400)
    const line = `${new Date(time).toISOString()} ${level.padEnd(5)} request ${path} answered in ${String(ms)} ms (id ${Math.floor(random() * 1e9).toString(36)})`
    lines.push(line)
    length += line.length + 1
  }
  return `${lines.join('\n')}\n`.slice(0, size)
}

function typescript(name: string): string {
  return [
    "import { useState } from 'react'",
    '',
    `/** ${name}: a small component, to show code in the viewer. */`,
    'export function Counter({ start = 0 }: { start?: number }) {',
    '  const [count, setCount] = useState(start)',
    '  return (',
    '    <button type="button" onClick={() => setCount(count + 1)}>',
    '      Clicked {count} times',
    '    </button>',
    '  )',
    '}',
    '',
  ].join('\n')
}

function yaml(): string {
  return ['packages:', "  - 'apps/*'", "  - 'packages/*'", 'catalog:', '  zod: ^4.6.5', ''].join(
    '\n',
  )
}

function css(): string {
  return [
    ':root {',
    '  --accent: oklch(0.7 0.15 250);',
    '}',
    '',
    'body {',
    '  margin: 0;',
    '  font-family: system-ui, sans-serif;',
    '}',
    '',
  ].join('\n')
}

function html(name: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    `    <title>${escapeXml(name)}</title>`,
    '    <script>alert("shown as source, never run")</script>',
    '  </head>',
    '  <body>',
    '    <h1>Hello</h1>',
    '  </body>',
    '</html>',
    '',
  ].join('\n')
}

function prose(random: () => number, name: string): string {
  const words =
    'the a drive file folder link photo note list plan week trip copy share upload sync quiet bright small long'.split(
      ' ',
    )
  const paragraphs = [name, '']
  for (let paragraph = 0; paragraph < 6; paragraph += 1) {
    const sentence = Array.from(
      { length: 40 + Math.floor(random() * 40) },
      () => words[Math.floor(random() * words.length)],
    ).join(' ')
    paragraphs.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`, '')
  }
  return paragraphs.join('\n')
}

/**
 * A PDF of three pages of text, in Helvetica, which it doesn't embed, so
 * pdf.js reads its standard fonts, each with a picture, which makes the file
 * larger than pdf.js's first read: the rest comes in ranges. `null` for one
 * named “(damaged)”.
 */
export function samplePdf(name: string): SampleFile | null {
  if (name.includes('(damaged)')) return null
  // PDF strings here are ASCII: others would need an encoding of their own.
  const text = (value: string) =>
    value.replace(/[^\x20-\x7e]/g, '-').replace(/[\\()]/g, (char) => `\\${char}`)
  const lines = [
    'This PDF was made up by the demo, so the viewer has something to show.',
    'Its pages are drawn as they scroll into view, and its text can be selected.',
    'Zoom with the buttons below, Ctrl and the wheel, or + and -.',
  ]
  const pages = [1, 2, 3].map((number) =>
    [
      'BT /F1 22 Tf 72 700 Td',
      `(${text(name)}) Tj`,
      '/F1 12 Tf 0 -40 Td 16 TL',
      ...lines.map((line) => `(${text(line)}) Tj T*`),
      `0 -560 Td (Page ${String(number)} of 3) Tj`,
      'ET',
      'q 300 0 0 300 156 230 cm /Im0 Do Q',
    ].join('\n'),
  )
  // Objects: 1 catalog, 2 pages, 3 the font, then each page's page, content and picture.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${String(4 + index * 3)} 0 R`).join(' ')}] /Count ${String(pages.length)} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ...pages.flatMap((content, index) => {
      const picture = gradient(index)
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 ${String(6 + index * 3)} 0 R >> >> /Contents ${String(5 + index * 3)} 0 R >>`,
        `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
        `<< /Type /XObject /Subtype /Image /Width 96 /Height 96 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${String(picture.length)} >>\nstream\n${picture}\nendstream`,
      ]
    }),
  ]
  let body = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = body.length
    body += `${String(index + 1)} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = body.length
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`
  return { mimeType: 'application/pdf', body }
}

/** A 96 × 96 picture, as hexadecimal text, so the PDF stays ASCII and its offsets its length. */
function gradient(seed: number): string {
  const hex = (value: number) => Math.round(value).toString(16).padStart(2, '0')
  const rows: string[] = []
  for (let y = 0; y < 96; y += 1) {
    let row = ''
    for (let x = 0; x < 96; x += 1) {
      row += hex((x / 95) * 255) + hex((y / 95) * 255) + hex(((seed + 1) * 80) % 256)
    }
    rows.push(row)
  }
  return `${rows.join('\n')}>`
}
