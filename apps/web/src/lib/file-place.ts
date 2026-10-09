// Where a viewed file is read from (DESIGN.md §10.3, §10.4): the drive, by
// its owner, or a share link, by anyone who has it. The viewer and the player
// ask for everything under the file's path; what the drive keeps for a user,
// such as where they stopped a video, a link's viewers, who have no account,
// keep in their browser.

/** A file's place: its API path, and the link's token under a link. */
export interface FilePlace {
  /** `/files/:id`, or `/s/:token/files/:id`. */
  path: string
  /** `null` in the drive. */
  token: string | null
}

export function drivePlace(id: string): FilePlace {
  return { path: `/files/${id}`, token: null }
}

export function linkPlace(token: string, id: string): FilePlace {
  return { path: `/s/${token}/files/${id}`, token }
}

/**
 * The file's bytes for showing it, as an API path: through a link with
 * `?preview=1`, as looking never counts toward its download limit (§7.5).
 */
export function previewPath(place: FilePlace): string {
  return place.token === null ? `${place.path}/content` : `${place.path}/content?preview=1`
}
