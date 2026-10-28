// The bounds on what the Matroska reader asks for and accepts (DESIGN.md §10.4,
// D45), so that a file that is damaged, or only strange, costs a few reads and
// never a whole download. Each is named as the plan names it, and the later
// steps of the reader add theirs here.

/** One read to see an element's header: 64 KiB, far more than the 12 bytes the biggest header takes, so that the elements after it are likely to be in the same read. */
export const HEADER_READ = 64 * 1024

/** The most reads, after the head, that opening a file takes: 12. A file that needs another is damaged. */
export const MAX_INDEX_READS = 12

/** The most that a Tracks element takes: 16 MiB. A larger one is damaged, and is not read. */
export const TRACKS_LIMIT = 16 * 1024 * 1024

/** The most that the index reads, from the first Cluster, to find the first frames: 4 MiB, 1 MiB at a time, stopping as soon as it has them. */
export const FIRST_FRAMES_BYTES = 4 * 1024 * 1024

/** The first window of the search back from the Segment's end for the end of the last frame, when Info has no Duration: 1 MiB, and the windows after it double (as much again before what is read, within the open's reads), and none starts before the first Cluster. */
export const TAIL_BYTES = 1024 * 1024

/** The most reads one seek takes: 48. A seek that has needed that many stops with the best keyframe cluster it has, or the first Cluster. */
export const MAX_SEEK_READS = 48

/** The most that a Cues element takes to be read: 32 MiB. A longer one is not read, and a seek searches the clusters instead. */
export const CUES_LIMIT = 32 * 1024 * 1024

/** One guess of a search for a cluster, and the bytes read from a cluster to see that it holds a keyframe: 256 KiB. */
export const SEARCH_READ = 256 * 1024
