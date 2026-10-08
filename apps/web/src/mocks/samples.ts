import { splitExtension } from '@dfs/shared'

// What the demo's files hold, made up per file, so previews (§10.3) have
// something to show: the mock keeps no bytes but those uploaded to it.

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
