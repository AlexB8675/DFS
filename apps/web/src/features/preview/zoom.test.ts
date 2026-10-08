import { describe, expect, it } from 'vitest'
import { canPan, clampView, fitScale, scaleLimits, zoomAt } from './zoom'

const stage = { width: 1000, height: 800 }
const photo = { width: 4000, height: 3000 }

describe('image zoom (§10.3)', () => {
  it('fits a large photo, keeps a small one at 1:1, and grows a drawing', () => {
    expect(fitScale(photo, stage, false)).toBe(0.25)
    expect(fitScale({ width: 200, height: 100 }, stage, false)).toBe(1)
    expect(fitScale({ width: 150, height: 150 }, stage, true)).toBeCloseTo(800 / 150)
    // Nothing to measure yet: 1:1.
    expect(fitScale({ width: 0, height: 0 }, stage, true)).toBe(1)
  })

  it('zooms between fitting and eight times the larger of fitting and 1:1', () => {
    expect(scaleLimits(0.25)).toEqual({ min: 0.25, max: 8 })
    expect(scaleLimits(4)).toEqual({ min: 1, max: 32 })
  })

  it('keeps the point under the pointer where it was', () => {
    const view = { scale: 0.5, x: 0, y: 0 }
    const point = { x: 200, y: -100 }
    const zoomed = zoomAt(view, 2, point, photo, stage, 0.25)
    expect(zoomed.scale).toBe(1)
    // The image point under the pointer: (point - offset) / scale, before and after.
    expect((point.x - zoomed.x) / zoomed.scale).toBeCloseTo((point.x - view.x) / view.scale)
    expect((point.y - zoomed.y) / zoomed.scale).toBeCloseTo((point.y - view.y) / view.scale)
  })

  it('stops at its limits', () => {
    const fitted = { scale: 0.25, x: 0, y: 0 }
    expect(zoomAt(fitted, 0.5, { x: 0, y: 0 }, photo, stage, 0.25).scale).toBe(0.25)
    expect(zoomAt({ scale: 7, x: 0, y: 0 }, 4, { x: 0, y: 0 }, photo, stage, 0.25).scale).toBe(8)
  })

  it('keeps the image on the stage, and a side smaller than it centred', () => {
    // At 1:1 the photo is 4000 × 3000 on a 1000 × 800 stage: 1500 and 1100 to spare.
    expect(clampView({ scale: 1, x: 5000, y: -5000 }, photo, stage)).toEqual({
      scale: 1,
      x: 1500,
      y: -1100,
    })
    // At 0.3 it is 1200 × 900: wider and taller than the stage, by 100 and 50 on each side.
    expect(clampView({ scale: 0.3, x: 400, y: 400 }, photo, stage)).toEqual({
      scale: 0.3,
      x: 100,
      y: 50,
    })
    expect(clampView({ scale: 0.25, x: 300, y: 300 }, photo, stage)).toEqual({
      scale: 0.25,
      x: 0,
      y: 0,
    })
  })

  it('pans only an image larger than the stage', () => {
    expect(canPan({ scale: 0.25, x: 0, y: 0 }, photo, stage)).toBe(false)
    expect(canPan({ scale: 0.5, x: 0, y: 0 }, photo, stage)).toBe(true)
  })
})
