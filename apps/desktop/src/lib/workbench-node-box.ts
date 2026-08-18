/**
 * Single source of truth for the workbench node box.
 *
 * The renderer draws a rectangle of exactly these dimensions and the layout
 * derives every spacing constant from them. They used to be declared in the
 * renderer and *guessed at* in the layout (`forceCollide(62)` against a
 * half-width of 76), which made boxes overlap by ~14px by construction. Any
 * future change to the visual size now propagates to collision and clamping
 * automatically.
 */

export const NODE_WIDTH = 152
export const NODE_HEIGHT = 58

export const NODE_HALF_WIDTH = NODE_WIDTH / 2
export const NODE_HALF_HEIGHT = NODE_HEIGHT / 2

/** Minimum visible gutter between two boxes. */
export const NODE_GAP_X = 34
export const NODE_GAP_Y = 30

/** Preferred centre-to-centre separation (comfortable gutter). */
export const MIN_SEPARATION_X = NODE_WIDTH + NODE_GAP_X
export const MIN_SEPARATION_Y = NODE_HEIGHT + NODE_GAP_Y

/**
 * Hard floor: below this two boxes intersect (or touch). The separation pass
 * enforces THIS, not the preferred spacing, so a deliberately tight layered
 * grid is not shoved apart while still being provably overlap-free.
 */
export const HARD_SEPARATION_X = NODE_WIDTH + 10
export const HARD_SEPARATION_Y = NODE_HEIGHT + 10

/**
 * Radius of the circle that circumscribes the node rectangle. A collision
 * radius smaller than this cannot separate two boxes in the worst case.
 */
export const NODE_HALF_DIAGONAL = Math.hypot(NODE_HALF_WIDTH, NODE_HALF_HEIGHT)

/** Clamp inset: at least the half-size, so no box hangs off the canvas. */
export const CLAMP_INSET_X = NODE_HALF_WIDTH + 4
export const CLAMP_INSET_Y = NODE_HALF_HEIGHT + 4

export interface Rect {
  height: number
  width: number
  /** Left edge. */
  x: number
  /** Top edge. */
  y: number
}

export interface Point {
  x: number
  y: number
}

/** The drawn rectangle for a node whose CENTRE is at `point`. */
export const nodeRect = (point: Point): Rect => ({
  height: NODE_HEIGHT,
  width: NODE_WIDTH,
  x: point.x - NODE_HALF_WIDTH,
  y: point.y - NODE_HALF_HEIGHT
})

/**
 * Pure rectangle intersection test. Touching edges do NOT count as an
 * intersection (a zero-area overlap is not visible).
 */
export const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** True when `rect` lies entirely inside a `width` x `height` canvas. */
export const rectWithin = (rect: Rect, width: number, height: number): boolean =>
  rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height

export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum))

/** Clamp a node CENTRE so its whole box stays on canvas. */
export const clampCentre = (point: Point, width: number, height: number): Point => ({
  x: clamp(point.x, CLAMP_INSET_X, width - CLAMP_INSET_X),
  y: clamp(point.y, CLAMP_INSET_Y, height - CLAMP_INSET_Y)
})
