// The IDs of the elements that DFS's Matroska reader looks for, as RFC 8794
// (EBML) and RFC 9559 (Matroska) give them (DESIGN.md §10.4). An ID is a number
// of 1 to 4 bytes with its length marker kept in, which is how a file writes it:
// 0xA3 is the one byte `A3` and 0x1A45DFA3 the four bytes `1A 45 DF A3`. Only
// what the reader reads is named here; an element with another ID is skipped by
// its size.

export const ID = {
  // The EBML header, which starts a file, and the two elements that stand anywhere.
  EBML: 0x1a45dfa3,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeReadVersion: 0x4285,
  CRC32: 0xbf,
  Void: 0xec,

  // The Segment and the index of where its other elements are.
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,

  // Info.
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,

  // Tracks, and what a track says about itself.
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  DefaultDuration: 0x23e383,
  TrackTimestampScale: 0x23314f,
  Language: 0x22b59c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,

  // A picture track.
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,
  DisplayUnit: 0x54b2,
  Colour: 0x55b0,
  MatrixCoefficients: 0x55b1,
  BitsPerChannel: 0x55b2,
  ChromaSubsamplingHorz: 0x55b3,
  ChromaSubsamplingVert: 0x55b4,
  ChromaSitingHorz: 0x55b7,
  ChromaSitingVert: 0x55b8,
  Range: 0x55b9,
  TransferCharacteristics: 0x55ba,
  Primaries: 0x55bb,
  Projection: 0x7670,
  ProjectionPoseRoll: 0x7675,

  // A sound track.
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  OutputSamplingFrequency: 0x78b5,
  Channels: 0x9f,
  BitDepth: 0x6264,

  // What a track's frames are wrapped in (compression, encryption), which the reader refuses.
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentEncodingScope: 0x5032,
  ContentEncodingType: 0x5033,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  ContentEncryption: 0x5035,

  // Extra data carried beside the frames of a track (Dolby Vision's configuration, for one).
  BlockAdditionMapping: 0x41e4,
  BlockAddIDType: 0x41e7,
  BlockAddIDExtraData: 0x41ed,

  // Clusters, and the frames in them.
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,

  // Cues, the index of where the clusters are.
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  CueRelativePosition: 0xf0,

  // The rest of a Segment's children, which the reader passes over.
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
} as const

/** The IDs of the elements that stand directly inside a Segment, in whatever order a file puts them. */
export const TOP_LEVEL: ReadonlySet<number> = new Set<number>([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  ID.Cues,
  ID.Tags,
  ID.Chapters,
  ID.Attachments,
])
