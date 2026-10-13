import { describe, expect, it } from 'vitest'
import { describeDeviceAgent } from './device-agent'

// A device's User-Agent in a few words, for the list of devices (§7.6).

describe('describeDeviceAgent', () => {
  it('names the program, without its version or system', () => {
    expect(describeDeviceAgent('DFS Backup/1.0 (Windows 11)')).toBe('DFS Backup')
    expect(describeDeviceAgent('dfs-backup/0.1.0')).toBe('dfs-backup')
  })

  it('keeps what a program with no version says of itself', () => {
    expect(describeDeviceAgent('DFS Backup')).toBe('DFS Backup')
  })

  it('says what a browser is, as a session does', () => {
    const firefox =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0'
    expect(describeDeviceAgent(firefox)).toBe('Firefox on Windows')
  })

  it('has something to say for an agent that is only a version', () => {
    expect(describeDeviceAgent('/1.0')).toBe('An unknown client')
  })
})
