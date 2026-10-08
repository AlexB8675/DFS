// The image viewer's zoom and pan (DESIGN.md §10.3), as plain arithmetic:
// sizes in CSS pixels, and the image's centre as an offset from the stage's.

export interface Size {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** How the image is shown: its scale, and how far its centre is from the stage's. */
export interface View extends Point {
  scale: number
}

/** The widest a picture zooms in to, as a multiple of 1:1 or of fitting, whichever is larger. */
const MAX_ZOOM = 8

/**
 * The scale that shows all of the image. A photo smaller than the stage
 * stays at 1:1; a drawing (`vector`) grows to fill it, since it stays sharp.
 */
export function fitScale(image: Size, stage: Size, vector: boolean): number {
  if (image.width <= 0 || image.height <= 0 || stage.width <= 0 || stage.height <= 0) return 1
  const fit = Math.min(stage.width / image.width, stage.height / image.height)
  return vector ? fit : Math.min(fit, 1)
}

/** The scales a user can zoom between: from fitting (or 1:1, if smaller) up to `MAX_ZOOM` times. */
export function scaleLimits(fit: number): { min: number; max: number } {
  return { min: Math.min(fit, 1), max: Math.max(fit, 1) * MAX_ZOOM }
}

/**
 * Zooms by `factor` around `point` (from the stage's centre), so what is
 * under the pointer stays under it; then keeps the image on the stage.
 */
export function zoomAt(
  view: View,
  factor: number,
  point: Point,
  image: Size,
  stage: Size,
  fit: number,
): View {
  const { min, max } = scaleLimits(fit)
  const scale = Math.min(max, Math.max(min, view.scale * factor))
  const ratio = scale / view.scale
  return clampView(
    { scale, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio },
    image,
    stage,
  )
}

/**
 * Keeps the image on the stage: a side larger than the stage can't leave a
 * gap at either edge, and a smaller one stays centred.
 */
export function clampView(view: View, image: Size, stage: Size): View {
  const clamp = (offset: number, length: number, room: number) => {
    const slack = Math.max(0, (length * view.scale - room) / 2)
    return Math.min(slack, Math.max(-slack, offset))
  }
  return {
    scale: view.scale,
    x: clamp(view.x, image.width, stage.width),
    y: clamp(view.y, image.height, stage.height),
  }
}

/** Whether the image is larger than the stage, so a drag pans it rather than swiping. */
export function canPan(view: View, image: Size, stage: Size): boolean {
  return image.width * view.scale > stage.width + 1 || image.height * view.scale > stage.height + 1
}
