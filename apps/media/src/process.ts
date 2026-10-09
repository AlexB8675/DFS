import { spawn } from 'node:child_process'
import { setPriority } from 'node:os'
import type { Readable } from 'node:stream'

// Running ffmpeg's tools (DESIGN.md §6.7): at the lowest priority, cut off
// after a time, and each output bounded, so a crafted file can't hold the
// service or fill its memory.

const MAX_ERROR_BYTES = 64 * 1024
/** As low as a process can go, so the VPS's other work comes first. */
const LOWEST_PRIORITY = 19

export interface RunOptions {
  timeoutMs: number
  /** Outputs on pipes of their own, from fd 3 on (`pipe:3`); none means stdout. */
  pipes?: number
  /** Each output's limit, past which it is `null`. */
  maxBytes: number
  /** Stop the process when an output passes its limit, rather than drop the rest of it. */
  killPastMax?: boolean
}

export interface Ran {
  /** stdout, or each pipe from fd 3 on; `null` for one that passed its limit. */
  outputs: (Buffer | null)[]
  stderr: string
  code: number | null
  timedOut: boolean
}

export function run(command: string, args: string[], options: RunOptions): Promise<Ran> {
  const pipes = options.pipes ?? 0
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', pipes ? 'ignore' : 'pipe', 'pipe', ...Array<'pipe'>(pipes).fill('pipe')],
    })
    if (child.pid !== undefined) {
      try {
        setPriority(child.pid, LOWEST_PRIORITY)
      } catch {
        // Not allowed here: it runs at the priority it has.
      }
    }
    const streams = (pipes ? child.stdio.slice(3) : [child.stdout]) as Readable[]
    const outputs = streams.map(() => ({ chunks: [] as Buffer[], bytes: 0, tooLarge: false }))
    streams.forEach((stream, i) => {
      const output = outputs[i]
      if (!output) return
      stream.on('data', (data: Buffer) => {
        output.bytes += data.length
        if (output.bytes > options.maxBytes) {
          // The rest is read and dropped, so the process doesn't block on it.
          output.tooLarge = true
          output.chunks = []
          if (options.killPastMax) child.kill('SIGKILL')
          return
        }
        if (!output.tooLarge) output.chunks.push(data)
      })
    })
    const err: Buffer[] = []
    let errBytes = 0
    child.stderr?.on('data', (data: Buffer) => {
      errBytes += data.length
      if (errBytes <= MAX_ERROR_BYTES) err.push(data)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, options.timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        outputs: outputs.map((output) => (output.tooLarge ? null : Buffer.concat(output.chunks))),
        stderr: Buffer.concat(err).toString('utf8'),
        code,
        timedOut,
      })
    })
  })
}

/** The first line of what a tool said, for a reason to give. */
export function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim().slice(0, 300) ?? ''
}
