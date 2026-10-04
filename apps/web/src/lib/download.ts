import { apiFetch } from './api/client'
import { mocksEnabled } from './env'

/**
 * Saves `/api{path}` as a file. The real API answers with
 * `Content-Disposition: attachment`, so a plain navigation hands the download
 * to the browser's download manager (progress, no memory buffering). The mock
 * API cannot intercept a download navigation, so mock mode fetches the bytes
 * and saves them from memory.
 */
export async function downloadFromApi(path: string, fileName: string): Promise<void> {
  if (!mocksEnabled) {
    saveAs(`/api${path}`, fileName)
    return
  }
  const response = await apiFetch(path)
  const objectUrl = URL.createObjectURL(await response.blob())
  saveAs(objectUrl, fileName)
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl)
  }, 10_000)
}

function saveAs(href: string, fileName: string): void {
  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  link.click()
}
