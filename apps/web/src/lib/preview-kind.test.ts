import type { DriveNode } from '@dfs/shared'
import { describe, expect, it } from 'vitest'
import { isPreviewable, previewKind, supportOf } from './preview-kind'

const chrome = { appleImages: false }
const safari = { appleImages: true }

describe('previewKind (§10.3)', () => {
  it('shows the images every browser draws, by MIME type', () => {
    for (const type of [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/avif',
      'image/bmp',
      'image/x-icon',
      'image/vnd.microsoft.icon',
      'image/apng',
      'image/svg+xml',
    ]) {
      expect(previewKind('file', type, chrome)).toBe('image')
    }
    // Without parameters and in any case.
    expect(previewKind('file', 'Image/SVG+XML; charset=utf-8', chrome)).toBe('image')
  })

  it('shows HEIC, HEIF and TIFF only where Apple’s WebKit draws them', () => {
    for (const [name, type] of [
      ['IMG_0001.HEIC', 'image/heic'],
      ['scan.heif', 'image/heif'],
      ['fax.tiff', 'image/tiff'],
    ] as const) {
      expect(previewKind(name, type, chrome)).toBeNull()
      expect(previewKind(name, type, safari)).toBe('image')
      expect(previewKind(name, null, chrome)).toBeNull()
      expect(previewKind(name, null, safari)).toBe('image')
    }
  })

  it('trusts the MIME type over the name', () => {
    expect(previewKind('photo.jpg', 'text/plain', chrome)).toBeNull()
    expect(previewKind('photo.txt', 'image/png', chrome)).toBe('image')
    // Images no browser draws.
    expect(previewKind('layers.psd', 'image/vnd.adobe.photoshop', chrome)).toBeNull()
    expect(previewKind('raw.cr2', 'image/x-canon-cr2', safari)).toBeNull()
  })

  it('goes by the extension when the upload gave no type', () => {
    expect(previewKind('IMG_0001.JPG', null, chrome)).toBe('image')
    expect(previewKind('icon.ico', 'application/octet-stream', chrome)).toBe('image')
    // Sent without its type, an SVG isn't drawn.
    expect(previewKind('logo.svg', null, chrome)).toBeNull()
    expect(previewKind('notes', null, chrome)).toBeNull()
  })
})

describe('isPreviewable', () => {
  const node = (fields: Partial<DriveNode>): DriveNode => ({
    id: '01a11353-edcb-7c90-8918-70850edcd1f9',
    parentId: null,
    kind: 'file',
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    createdAt: '2026-10-08T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
    syncState: 'stored',
    hasChildFolders: false,
    ...fields,
  })

  it('opens only files that can be read: syncing or stored', () => {
    expect(isPreviewable(node({}), chrome)).toBe(true)
    expect(isPreviewable(node({ syncState: 'syncing' }), chrome)).toBe(true)
    expect(isPreviewable(node({ syncState: 'uploading' }), chrome)).toBe(false)
    expect(isPreviewable(node({ syncState: 'failed' }), chrome)).toBe(false)
    expect(isPreviewable(node({ kind: 'folder', mimeType: null, syncState: null }), chrome)).toBe(
      false,
    )
  })
})

describe('supportOf', () => {
  it('finds Apple’s WebKit, whichever browser runs on it', () => {
    const mac =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
    const iosChrome =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1'
    const chromeDesktop =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    const android =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
    const firefox =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'
    expect(supportOf(mac).appleImages).toBe(true)
    expect(supportOf(iosChrome).appleImages).toBe(true)
    expect(supportOf(chromeDesktop).appleImages).toBe(false)
    expect(supportOf(android).appleImages).toBe(false)
    expect(supportOf(firefox).appleImages).toBe(false)
  })
})
