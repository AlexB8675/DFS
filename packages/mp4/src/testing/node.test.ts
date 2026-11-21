import { expect, it } from 'vitest'
import * as node from '@dfs/mp4/testing/node'

// The player's test server reuses the corpus helpers through this Node-only subpath (DESIGN.md §10.4).
it('resolves @dfs/mp4/testing/node with what the player test server uses', () => {
  expect(Object.keys(node).sort()).toEqual([
    'containerOf',
    'isSynthetic',
    'loadManifest',
    'parseRange',
    'syntheticDir',
    'uniqueTitles',
  ])
})
