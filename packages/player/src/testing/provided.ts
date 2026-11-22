// What the browser suites are given by `inject('playServer')`, and what they say to its control
// channel (DESIGN.md §10.4): types only, so that both the Node side (play-server.ts, which
// provides it) and the browser side (src/browser/server.ts, which injects it) can say them
// without the other's libraries.

/** What goes wrong at the next request that has no fault before it. */
export type Fault =
  /** The headers and `afterBytes` of the body are sent, then the connection is destroyed. */
  | { kind: 'drop'; afterBytes: number }
  /** `afterBytes` are sent, then nothing for `ms` (`null`: until the client gives up or the server closes), and then the rest. */
  | { kind: 'stall'; afterBytes: number; ms: number | null }
  /** That status, with an empty body, and `Retry-After` when it is given. */
  | { kind: 'status'; status: number; retryAfter?: string }

/** The network that the following requests see. A field that is left out is no limit, no wait and no fault. */
export interface Network {
  bandwidthBytesPerSecond?: number
  latencyMs?: number
  faults?: Fault[]
}

/** One request the server saw. */
export interface LogEntry {
  /** The file's id, null for a connection that was refused before any request was read. */
  id: string | null
  /** The request's `Range` header, null when it had none. */
  range: string | null
  /** The status it was answered with, 0 for a connection that was refused. */
  status: number
  /** The body bytes handed to the connection. */
  bytesSent: number
  /** `open` is a response that is still being sent. */
  outcome: 'open' | 'done' | 'dropped' | 'aborted' | 'refused'
}

/** One file of the corpus as a browser knows it: served at `${base}/file/${id}`, never by path. */
export interface PlayFile {
  id: string
  /** The folder's name and the file's (`Final/a.mp4`), different for every file. */
  name: string
  /** Whether `corpus:make` made it, as against one of the user's videos, which are read in place. */
  synthetic: boolean
  /** Its tracks end far apart: it plays only to the shorter track's end. */
  uneven?: true
  size: number
  expect: 'plays' | { refused: string }
}

/** The play server: where its two planes are (each ending in the run's random token) and the files of the manifest that are there. */
export interface PlayServerInfo {
  /** The data plane: files are at `${base}/file/${id}`. */
  base: string
  /** The control plane, on its own port with the same token: `/control`, `/switch` and `/log`, which a network change does not cut. */
  controlBase: string
  files: PlayFile[]
}

declare module 'vitest' {
  export interface ProvidedContext {
    playServer: PlayServerInfo
    /** Whether every file that is expected to play is to be played (`DFS_CORPUS_ALL=1`), and not the sample of the user's. */
    playAll: boolean
  }
}

/** What a look into the browser's profile folder found (src/testing/profile-scan.ts): the files it read, those that hold the run, and those it could not read (a browser keeps some locked). */
export interface Scan {
  scanned: number
  holding: number
  unreadable: number
  /** The paths, relative to the profile folder, of the files that hold the run: names only. */
  where: string[]
}

declare module 'vitest/browser' {
  export interface BrowserCommands {
    /** Counts the files of the browser's profile folder that hold the run of bytes given as hex: the Node side's, for the HTTP cache check. Null when the browser has no profile folder of its own (it is not Chrome's persistent context). */
    scanProfile: (hex: string) => Promise<Scan | null>
  }
}
