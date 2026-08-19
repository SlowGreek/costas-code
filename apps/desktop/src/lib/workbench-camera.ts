/**
 * The workbench canvas camera.
 *
 * A camera describes the window of WORLD (canvas) space that is currently
 * visible. It is applied in exactly one place — the SVG `viewBox` — and
 * nowhere else. Node geometry, layout, pins, persisted artifact data and the
 * spatial language handed to the voice model all stay in world units, so the
 * model's map of the canvas does not move when the user zooms.
 *
 * `x`/`y` is the world point at the window's top-left corner. `zoom` > 1 shows
 * LESS of the world (things look bigger).
 *
 * Everything here is pure and DOM-free so the maths is unit-testable, and so
 * a future gesture/hand-tracking driver can reuse it unchanged. Keep every
 * mutation continuous — no snapping to discrete steps — for the same reason.
 */

export interface WorkbenchCamera {
  x: number
  y: number
  zoom: number
}

export interface WorkbenchWorld {
  height: number
  width: number
}

interface Point {
  x: number
  y: number
}

export const IDENTITY_CAMERA: WorkbenchCamera = Object.freeze({ x: 0, y: 0, zoom: 1 })

export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4

/**
 * How much of the world must remain inside the window. Panning is free until
 * only this fraction overlaps, which prevents the user losing the drawing
 * entirely while still allowing a node to be dragged to a screen edge.
 */
const MIN_OVERLAP = 0.25

const isFiniteCamera = (camera: WorkbenchCamera): boolean =>
  Number.isFinite(camera.x) && Number.isFinite(camera.y) && Number.isFinite(camera.zoom)

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high)

/** The size of the visible window, in world units. */
export function visibleSize(camera: WorkbenchCamera, world: WorkbenchWorld): WorkbenchWorld {
  const zoom = clamp(camera.zoom, MIN_ZOOM, MAX_ZOOM)

  return { height: world.height / zoom, width: world.width / zoom }
}

/**
 * Constrain a camera to something renderable: finite, within the zoom range,
 * and still overlapping the world.
 *
 * A degenerate world (zero width/height, which happens for one frame before
 * the pane is measured) has nothing to frame, so identity is the honest
 * answer rather than a division by zero.
 */
export function clampCamera(camera: WorkbenchCamera, world: WorkbenchWorld): WorkbenchCamera {
  if (!isFiniteCamera(camera) || world.width <= 0 || world.height <= 0) {
    return { ...IDENTITY_CAMERA }
  }

  const zoom = clamp(camera.zoom, MIN_ZOOM, MAX_ZOOM)
  const view = { height: world.height / zoom, width: world.width / zoom }

  // Keep at least MIN_OVERLAP of the smaller of (world, window) on screen.
  const slackX = Math.min(world.width, view.width) * MIN_OVERLAP
  const slackY = Math.min(world.height, view.height) * MIN_OVERLAP

  return {
    x: clamp(camera.x, slackX - view.width, world.width - slackX),
    y: clamp(camera.y, slackY - view.height, world.height - slackY),
    zoom
  }
}

const format = (value: number): string => {
  const rounded = Math.round(value * 100) / 100

  // Integers must render WITHOUT a decimal tail so the identity camera emits
  // exactly the string the pre-camera renderer did.
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

/** The SVG `viewBox` attribute for this camera. */
export function cameraViewBox(camera: WorkbenchCamera, world: WorkbenchWorld): string {
  if (world.width <= 0 || world.height <= 0) {
    return `0 0 ${format(Math.max(0, world.width))} ${format(Math.max(0, world.height))}`
  }

  const safe = clampCamera(camera, world)
  const view = visibleSize(safe, world)

  return `${format(safe.x)} ${format(safe.y)} ${format(view.width)} ${format(view.height)}`
}

/**
 * Zoom about a focal world point, keeping that point visually still.
 *
 * This is what makes wheel-zoom-at-cursor feel correct: the thing under the
 * pointer stays under the pointer.
 */
export function zoomAt(
  camera: WorkbenchCamera,
  world: WorkbenchWorld,
  focal: Point,
  nextZoom: number
): WorkbenchCamera {
  const safe = clampCamera(camera, world)

  if (!Number.isFinite(nextZoom)) {
    return safe
  }

  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)
  const before = visibleSize(safe, world)
  const after = { height: world.height / zoom, width: world.width / zoom }

  // Where the focal point sits in the window, as a 0..1 ratio. Preserve it.
  const ratioX = before.width === 0 ? 0.5 : (focal.x - safe.x) / before.width
  const ratioY = before.height === 0 ? 0.5 : (focal.y - safe.y) / before.height

  return clampCamera(
    { x: focal.x - ratioX * after.width, y: focal.y - ratioY * after.height, zoom },
    world
  )
}

/**
 * Pan by a delta expressed in ELEMENT pixels.
 *
 * The delta is divided by zoom so a drag of N screen pixels always moves the
 * content N screen pixels, whatever the zoom level — the content sticks to
 * the pointer.
 */
export function panCamera(
  camera: WorkbenchCamera,
  world: WorkbenchWorld,
  delta: Point
): WorkbenchCamera {
  const safe = clampCamera(camera, world)

  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) {
    return safe
  }

  return clampCamera(
    { x: safe.x - delta.x / safe.zoom, y: safe.y - delta.y / safe.zoom, zoom: safe.zoom },
    world
  )
}

/** A camera that centres a world point — used by the voice `zoom_to` tool. */
export function cameraForNode(
  point: Point,
  world: WorkbenchWorld,
  zoom: number
): WorkbenchCamera {
  const safeZoom = Number.isFinite(zoom) ? clamp(zoom, MIN_ZOOM, MAX_ZOOM) : 1
  const view = { height: world.height / safeZoom, width: world.width / safeZoom }

  return clampCamera(
    { x: point.x - view.width / 2, y: point.y - view.height / 2, zoom: safeZoom },
    world
  )
}

/** True when nothing is applied — the reset affordance stays hidden. */
export function isIdentityCamera(camera: WorkbenchCamera): boolean {
  return camera.x === 0 && camera.y === 0 && camera.zoom === 1
}

/* --- input interpretation -------------------------------------------- */
//
// Kept pure and separate from React so the same rules can later be driven by
// a gesture/hand-tracking source. Every result is continuous — nothing snaps
// to discrete steps — because a hand has no detents.

/** How far a pointer must move before a press counts as a drag, in px. */
const PAN_THRESHOLD = 4

/** Wheel-delta to zoom-ratio sensitivity. Tuned for trackpad pinch. */
const WHEEL_SENSITIVITY = 0.0015

export interface WheelLike {
  ctrlKey: boolean
  deltaX: number
  deltaY: number
  metaKey: boolean
}

/**
 * What a wheel event means.
 *
 * A trackpad pinch arrives as a wheel event with `ctrlKey` set — that is the
 * browser convention, not a modifier the user is holding.
 */
export function wheelIntent(event: WheelLike): 'none' | 'pan' | 'zoom' {
  if (event.deltaX === 0 && event.deltaY === 0) {
    return 'none'
  }

  return event.ctrlKey || event.metaKey ? 'zoom' : 'pan'
}

/**
 * The zoom a wheel delta should produce.
 *
 * Multiplicative, so the same gesture changes zoom by the same RATIO at every
 * scale — an additive step crawls when zoomed out and leaps when zoomed in.
 */
export function zoomStepFromWheel(zoom: number, deltaY: number): number {
  if (!Number.isFinite(zoom) || !Number.isFinite(deltaY)) {
    return clamp(Number.isFinite(zoom) ? zoom : 1, MIN_ZOOM, MAX_ZOOM)
  }

  return clamp(zoom * Math.exp(-deltaY * WHEEL_SENSITIVITY), MIN_ZOOM, MAX_ZOOM)
}

/**
 * Whether a press-and-move should be treated as a pan.
 *
 * Mirrors the rule node drag already uses: a press with no movement is a
 * click. Without this a pan would clear the user's selection every time.
 */
export function isPanGesture(origin: Point, current: Point): boolean {
  return Math.hypot(current.x - origin.x, current.y - origin.y) >= PAN_THRESHOLD
}
