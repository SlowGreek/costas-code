import { describe, expect, it } from 'vitest'

import {
  IDENTITY_CAMERA,
  isPanGesture,
  MAX_ZOOM,
  MIN_ZOOM,
  panCamera,
  wheelIntent,
  zoomAt,
  zoomStepFromWheel
} from './workbench-camera'

const world = { height: 420, width: 720 }

describe('wheel intent', () => {
  it('treats ctrl/meta wheel as zoom (this is what a trackpad pinch emits)', () => {
    expect(wheelIntent({ ctrlKey: true, deltaX: 0, deltaY: -10, metaKey: false })).toBe('zoom')
    expect(wheelIntent({ ctrlKey: false, deltaX: 0, deltaY: -10, metaKey: true })).toBe('zoom')
  })

  it('treats a plain wheel as pan', () => {
    expect(wheelIntent({ ctrlKey: false, deltaX: 0, deltaY: -10, metaKey: false })).toBe('pan')
  })

  it('ignores a wheel event with no movement rather than eating the event', () => {
    expect(wheelIntent({ ctrlKey: false, deltaX: 0, deltaY: 0, metaKey: false })).toBe('none')
    expect(wheelIntent({ ctrlKey: true, deltaX: 0, deltaY: 0, metaKey: false })).toBe('none')
  })
})

describe('zoomStepFromWheel', () => {
  it('scrolling up zooms in, down zooms out', () => {
    expect(zoomStepFromWheel(1, -100)).toBeGreaterThan(1)
    expect(zoomStepFromWheel(1, 100)).toBeLessThan(1)
  })

  it('is continuous, not stepped — hand tracking will drive this too', () => {
    const small = zoomStepFromWheel(1, -10)
    const large = zoomStepFromWheel(1, -100)

    expect(small).toBeGreaterThan(1)
    expect(large).toBeGreaterThan(small)
  })

  it('is multiplicative, so zooming feels the same at every scale', () => {
    // The same gesture should change zoom by the same RATIO, not the same
    // absolute amount — otherwise it crawls when zoomed out and leaps in.
    const fromOne = zoomStepFromWheel(1, -50) / 1
    const fromTwo = zoomStepFromWheel(2, -50) / 2

    expect(fromOne).toBeCloseTo(fromTwo, 5)
  })

  it('stays inside the supported range', () => {
    expect(zoomStepFromWheel(MAX_ZOOM, -10000)).toBeLessThanOrEqual(MAX_ZOOM)
    expect(zoomStepFromWheel(MIN_ZOOM, 10000)).toBeGreaterThanOrEqual(MIN_ZOOM)
  })
})

describe('isPanGesture', () => {
  it('a press with no movement is a click, not a pan', () => {
    // Same rule the node drag already uses: a pan must not clear the user's
    // selection, but a genuine background click still must.
    expect(isPanGesture({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(false)
    expect(isPanGesture({ x: 0, y: 0 }, { x: 2, y: 1 })).toBe(false)
  })

  it('movement past the threshold is a pan', () => {
    expect(isPanGesture({ x: 0, y: 0 }, { x: 20, y: 0 })).toBe(true)
    expect(isPanGesture({ x: 0, y: 0 }, { x: 0, y: -20 })).toBe(true)
  })
})

describe('camera interaction end to end', () => {
  it('wheel-zoom about the cursor keeps the cursor point still', () => {
    const focal = { x: 600, y: 100 }
    const next = zoomAt(IDENTITY_CAMERA, world, focal, zoomStepFromWheel(1, -100))

    const relAfter = {
      x: (focal.x - next.x) / (world.width / next.zoom),
      y: (focal.y - next.y) / (world.height / next.zoom)
    }

    expect(relAfter.x).toBeCloseTo(600 / 720, 5)
    expect(relAfter.y).toBeCloseTo(100 / 420, 5)
  })

  it('pan then reverse pan returns to where it started', () => {
    const out = panCamera({ x: 100, y: 100, zoom: 2 }, world, { x: 30, y: -20 })
    const back = panCamera(out, world, { x: -30, y: 20 })

    expect(back.x).toBeCloseTo(100, 5)
    expect(back.y).toBeCloseTo(100, 5)
  })
})
