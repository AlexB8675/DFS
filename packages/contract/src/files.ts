import {
  nodeSchema,
  sessionSchema,
  uploadBatchResultSchema,
  type DriveNode,
  type UploadSession,
} from '@dfs/shared'
import type { ApiClient } from './client.ts'

// Helpers for tests that need folders and files, used the way the web app's
// upload engine uses the API (DESIGN.md §6.1, §10.2).

/** A fresh, uniquely named folder in the signed-in user's root, so tests don't see each other. */
export async function workspace(client: ApiClient): Promise<DriveNode> {
  const { user } = await client.call('GET', '/auth/me', sessionSchema)
  return createFolder(client, user.rootFolderId, `Test ${crypto.randomUUID().slice(0, 8)}`)
}

export function createFolder(
  client: ApiClient,
  parentId: string,
  name: string,
): Promise<DriveNode> {
  return client.call('POST', '/folders', nodeSchema, { json: { parentId, name } })
}

/** Starts an upload session, as the engine does in batches. */
export async function startUpload(
  client: ApiClient,
  parentId: string,
  name: string,
  sizeBytes: number,
): Promise<UploadSession> {
  const { results } = await client.call('POST', '/uploads/batch', uploadBatchResultSchema, {
    json: { uploads: [{ parentId, name, sizeBytes, mimeType: 'application/octet-stream' }] },
  })
  const [result] = results
  if (!result?.ok) throw new Error(`Upload of ${name} refused: ${JSON.stringify(result)}`)
  return result.session
}

/** Sends one part with its SHA-256, as the engine does. */
export async function sendPart(
  client: ApiClient,
  session: UploadSession,
  index: number,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const part = bytes.slice(index * session.chunkSize, (index + 1) * session.chunkSize)
  await client.send('PUT', `/uploads/${session.uploadId}/parts/${String(index)}`, {
    body: part,
    headers: { 'X-Part-SHA256': await sha256Hex(part) },
  })
}

/** Streams the file from part `from` to its end in one request, as the engine sends a larger file. */
export async function streamFrom(
  client: ApiClient,
  session: UploadSession,
  from: number,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  await client.send('PUT', `/uploads/${session.uploadId}/content?from=${String(from)}`, {
    body: bytes.slice(from * session.chunkSize),
  })
}

/** Every part's SHA-256, which completing a streamed upload sends. */
export function partHashes(session: UploadSession, bytes: Uint8Array<ArrayBuffer>) {
  return Promise.all(
    Array.from({ length: session.chunkCount }, (_, index) =>
      sha256Hex(bytes.slice(index * session.chunkSize, (index + 1) * session.chunkSize)),
    ),
  )
}

/** Uploads a whole file: a session, every part, and completion when there is more than one. */
export async function uploadFile(
  client: ApiClient,
  parentId: string,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<UploadSession> {
  const session = await startUpload(client, parentId, name, bytes.length)
  for (let index = 0; index < session.chunkCount; index += 1) {
    await sendPart(client, session, index, bytes)
  }
  if (session.chunkCount !== 1) await client.send('POST', `/uploads/${session.uploadId}/complete`)
  return session
}

export function text(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value)
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
