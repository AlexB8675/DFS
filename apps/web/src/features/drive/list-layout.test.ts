import { describe, expect, it } from 'vitest'
import { listLayout } from './list-layout'

describe('listLayout', () => {
  it('shows the date and size once there is room, and not before', () => {
    expect(listLayout(360, false).details).toBe(false)
    expect(listLayout(520, false).details).toBe(true)
    expect(listLayout(1200, false).location).toBe('none')
  })

  it('uses the roomy layout until the list has been measured', () => {
    expect(listLayout(0, false).details).toBe(true)
    expect(listLayout(0, true).location).toBe('column')
  })

  it('never hides a search result’s folder: it moves under the name when narrow', () => {
    expect(listLayout(360, true)).toMatchObject({ details: false, location: 'under' })
    expect(listLayout(700, true)).toMatchObject({ details: true, location: 'under' })
    expect(listLayout(900, true)).toMatchObject({ details: true, location: 'column' })
  })

  it('gives the header and the rows one template', () => {
    for (const width of [300, 520, 700, 900]) {
      for (const showLocation of [false, true]) {
        const layout = listLayout(width, showLocation)
        const tracks = layout.columns.split('_').length
        // Name, [location], [modified, size], sync.
        expect(tracks).toBe(2 + (layout.location === 'column' ? 1 : 0) + (layout.details ? 2 : 0))
      }
    }
  })
})
