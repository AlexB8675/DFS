// The bounds on what the Matroska reader asks for and accepts (DESIGN.md §10.4,
// D45), so that a file that is damaged, or only strange, costs a few reads and
// never a whole download. Each is named as the plan names it, and the later
// steps of the reader add theirs here.

/** One read to see an element's header: 64 KiB, far more than the 12 bytes the biggest header takes, so that the elements after it are likely to be in the same read. */
export const HEADER_READ = 64 * 1024

/** The most reads, after the head, that opening a file takes: 12. A file that needs another is damaged. */
export const MAX_INDEX_READS = 12
