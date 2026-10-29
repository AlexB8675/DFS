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

/** The most elements that the walk of a Tracks element takes (a TrackEntry or any other, a CRC-32 or a Void not counted): 1024, where a file has a few dozen tracks at most. The elements after them are ignored, and the file is not refused for them. */
export const MAX_TRACK_ENTRIES = 1024

/** The most children that the walk of an element inside a track's entry takes (the entry itself, its Video, Audio, Colour, Projection, BlockAdditionMapping and ContentEncodings and what they hold; a CRC-32 and a Void counted): 1024, where an entry has about 30 children, a Video 20 and the rest a handful. An element with more is damaged, and with it the track, which is kept with its problem and never refuses the file. */
export const MAX_ENTRY_CHILDREN = 1024

/** The most that the index reads, from the first Cluster, to find the first frames: 4 MiB, 1 MiB at a time, stopping as soon as it has them. */
export const FIRST_FRAMES_BYTES = 4 * 1024 * 1024

/** The first window of the search back from the Segment's end for the end of the last frame, when Info has no Duration: 1 MiB, and the windows after it double (as much again before what is read, within the open's reads), and none starts before the first Cluster. */
export const TAIL_BYTES = 1024 * 1024

/** The most reads one seek takes: 48. A seek that has needed that many and needs another stops at the first Cluster, which is at or before any time. */
export const MAX_SEEK_READS = 48

/** The most that a Cues element takes to be read: 32 MiB. A longer one is not read, and a seek searches the clusters instead. */
export const CUES_LIMIT = 32 * 1024 * 1024

/** The most children that the walk of a Cues element takes: 2^20, where the Cues of a ten-hour film have about a hundred thousand points. Cues with more are damaged, and a seek searches the clusters instead; their points are never cut short, for a seek by points that stop early would land far too early. */
export const MAX_CUE_POINTS = 2 ** 20

/** The most children that the walk of a CuePoint, or of a CueTrackPositions, takes: 64, where a real one has a handful. One with more is damaged, as the Cues that hold it are. */
export const MAX_CUE_FIELDS = 64

/** One guess of a search for a cluster, and the bytes read from a cluster to see that it holds a keyframe: 256 KiB. */
export const SEARCH_READ = 256 * 1024
