import { describe, expect, it } from 'vitest'
import { createSelectionStore } from './selection'

const ids = ['a', 'b', 'c', 'd', 'e']

function selected(store: ReturnType<typeof createSelectionStore>) {
  return [...store.getState().selected].sort()
}

describe('selection store', () => {
  it('selects one item and makes it the anchor and cursor', () => {
    const store = createSelectionStore()
    store.getState().select('b')
    expect(selected(store)).toEqual(['b'])
    expect(store.getState().anchorId).toBe('b')
    expect(store.getState().activeId).toBe('b')
  })

  it('toggles items in and out', () => {
    const store = createSelectionStore()
    store.getState().toggle('a')
    store.getState().toggle('c')
    store.getState().toggle('a')
    expect(selected(store)).toEqual(['c'])
  })

  it('selects a range from the anchor in either direction', () => {
    const store = createSelectionStore()
    store.getState().select('b')
    store.getState().selectRange(ids, 'd')
    expect(selected(store)).toEqual(['b', 'c', 'd'])

    // Shrinking or flipping the range keeps the original anchor.
    store.getState().selectRange(ids, 'a')
    expect(selected(store)).toEqual(['a', 'b'])
    expect(store.getState().anchorId).toBe('b')
  })

  it('falls back to a single selection when the anchor is gone', () => {
    const store = createSelectionStore()
    store.getState().select('x')
    store.getState().selectRange(ids, 'c')
    expect(selected(store)).toEqual(['c'])
  })

  it('starts with an initial item, e.g. from a search result', () => {
    const store = createSelectionStore('d')
    expect(selected(store)).toEqual(['d'])
    expect(store.getState().activeId).toBe('d')
  })

  it('clears the selection but keeps the cursor', () => {
    const store = createSelectionStore()
    store.getState().selectAll(ids)
    store.getState().setActive('c')
    store.getState().clear()
    expect(selected(store)).toEqual([])
    expect(store.getState().activeId).toBe('c')
  })
})
