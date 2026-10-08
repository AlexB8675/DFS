import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, normalize, sep } from 'node:path'
import type { Plugin } from 'vite'

// pdf.js's data files (DESIGN.md §10.3): character maps and standard fonts
// for PDFs that don't embed theirs, and the JavaScript image decoders it
// uses instead of WebAssembly, which the CSP doesn't allow. They are served
// as they are, under a path with pdf.js's version, so Caddy can keep them
// for a year like the hashed assets.

const pdfjsRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))

/** What the app loads, relative to pdf.js's package: each folder, and which of its files. */
const FOLDERS: Record<string, (file: string) => boolean> = {
  cmaps: () => true,
  standard_fonts: (file) => !file.startsWith('LICENSE'),
  wasm: (file) => file.endsWith('_nowasm_fallback.js'),
}

/** `/assets/pdfjs-<version>/`: where the files are; the app builds it from pdf.js's version too. */
export async function pdfjsAssetsBase(): Promise<string> {
  const { version } = JSON.parse(await readFile(join(pdfjsRoot, 'package.json'), 'utf8')) as {
    version: string
  }
  return `assets/pdfjs-${version}/`
}

export function pdfjsAssets(): Plugin {
  return {
    name: 'dfs:pdfjs-assets',
    // In development, straight from node_modules.
    async configureServer(server) {
      const base = `/${await pdfjsAssetsBase()}`
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0] ?? ''
        if (!path.startsWith(base)) {
          next()
          return
        }
        const relative = normalize(decodeURIComponent(path.slice(base.length)))
        const [folder = '', file = ''] = relative.split(sep)
        const allowed = FOLDERS[folder]
        if (!allowed?.(file) || relative.split(sep).length !== 2) {
          response.statusCode = 404
          response.end()
          return
        }
        const source = join(pdfjsRoot, folder, file)
        stat(source).then(
          () => {
            if (file.endsWith('.js')) response.setHeader('Content-Type', 'text/javascript')
            createReadStream(source).pipe(response)
          },
          () => {
            response.statusCode = 404
            response.end()
          },
        )
      })
    },
    // In a build, copied next to the app's assets.
    async generateBundle() {
      const base = await pdfjsAssetsBase()
      for (const [folder, allowed] of Object.entries(FOLDERS)) {
        for (const file of await readdir(join(pdfjsRoot, folder))) {
          if (!allowed(file)) continue
          this.emitFile({
            type: 'asset',
            fileName: `${base}${folder}/${file}`,
            source: await readFile(join(pdfjsRoot, folder, file)),
          })
        }
      }
    },
  }
}
