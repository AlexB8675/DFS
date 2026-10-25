// Why DFS's own MP4 reader turns a file away (DESIGN.md §10.4, D45). A file it
// can't repackage is refused with one of these and a sentence the player can
// show; nothing else is thrown for a malformed file.

/**
 * What is wrong with a file the reader refuses:
 * - `fragmented`: it is already in fragments (it has an `mvex` or a `moof`), so there is nothing to split.
 * - `no-picture`: it has no video track.
 * - `several-descriptions`: its picture or sound has more than one sample description.
 * - `edit-list`: its edit list does something the init segment can't say (§10.4).
 * - `unsupported-codec`: its picture or sound is in a codec that no browser's Media Source takes in MP4.
 * - `external-data`: its picture or sound is kept in another file (a QuickTime reference movie), which the player can't read.
 * - `damaged`: its boxes or tables are cut short, contradict themselves or don't add up.
 */
export type Mp4Refusal =
  | 'fragmented'
  | 'no-picture'
  | 'several-descriptions'
  | 'edit-list'
  | 'unsupported-codec'
  | 'external-data'
  | 'damaged'

export class Mp4Error extends Error {
  readonly reason: Mp4Refusal

  constructor(reason: Mp4Refusal, message: string) {
    super(message)
    this.name = 'Mp4Error'
    this.reason = reason
  }
}
