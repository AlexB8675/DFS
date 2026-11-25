import { z } from 'zod'

// Wire formats of the agent API, `/api/v1` (DESIGN.md §7.8): paths relative to
// the app token's folder, with no leading slash.

/** A file or folder inside the token's folder. */
export const appItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  /** Relative to the token's folder, as stored: `Photos/2024/a.jpg`. */
  path: z.string(),
  kind: z.enum(['file', 'folder']),
  /** A folder's total, as the drive shows it. */
  size: z.number().int().min(0),
  mimeType: z.string().nullable(),
  modifiedAt: z.iso.datetime(),
  /** A file's current version; `null` for a folder. */
  version: z.string().nullable(),
})
export type AppItem = z.infer<typeof appItemSchema>

/** A page of a folder's items: folders first, then files. */
export const appListSchema = z.object({
  items: z.array(appItemSchema),
  nextCursor: z.string().nullable(),
})
export type AppList = z.infer<typeof appListSchema>

/** `GET /v1/me`: what the token is, and who it signs in as. */
export const appMeSchema = z.object({
  token: z.object({
    name: z.string(),
    folder: z.object({ name: z.string(), path: z.string() }),
    canWrite: z.boolean(),
  }),
  user: z.object({ displayName: z.string() }),
})
export type AppMe = z.infer<typeof appMeSchema>

/** `POST /v1/move`: paths in the body are plain text, not percent-encoded. */
export const appMoveSchema = z.object({ from: z.string().max(4096), to: z.string().max(4096) })
export type AppMove = z.infer<typeof appMoveSchema>
