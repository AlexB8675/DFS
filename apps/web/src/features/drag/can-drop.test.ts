import { describe, expect, it } from 'vitest'
import { canDrop } from './can-drop'

const file = { id: 'file', parentId: 'docs' }
const folder = { id: 'photos', parentId: 'root' }

describe('canDrop', () => {
  it('accepts a move into another folder', () => {
    expect(canDrop([file, folder], 'archive')).toBe(true)
  })

  it('refuses a folder onto itself or into its own subtree', () => {
    expect(canDrop([folder], 'photos')).toBe(false)
    // The tree says the target sits inside Photos.
    expect(canDrop([folder], '2024', ['2024', 'photos', 'root'])).toBe(false)
  })

  it('refuses a drop that would change nothing', () => {
    expect(canDrop([file], 'docs')).toBe(false)
    // Mixed parents: at least one item moves.
    expect(canDrop([file, folder], 'docs')).toBe(true)
  })

  it('refuses an empty drag', () => {
    expect(canDrop([], 'docs')).toBe(false)
  })
})
