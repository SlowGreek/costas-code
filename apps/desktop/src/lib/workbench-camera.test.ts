import { describe, expect, it } from 'vitest'

import {
  cameraForNode,
  cameraViewBox,
  clampCamera,
  IDENTITY_CAMERA,
  isIdentityCamera,
  panCamera,
  zoomAt
} from './workbench-camera'

const world = { height: 420, width: 720 }

describe('workbench camera', () => {
  it('identity camera renders exactly the legacy viewBox string', () => {
    // The single strongest anti-degradation guarantee: with no camera applied,
    // the emitted attribute is byte-identical to the pre-camera renderer.
    expect(cameraViewBox(IDENTITY_CAMERA, world)).toBe('0 0 720 420')
  })

  it('zooming in halves the visible window', () => {
    expect(cameraViewBox({ x: 0, y: 0, zoom: 2 }, world)).toBe('0 0 360 210')
  })

  it('zooming out widens the visible window', () => {
    expect(cameraViewBox({ x: 0, y: 0, zoom: 0.5 }, world)).toBe('0 0 1440 840')
  })

  it('clamps zoom to the supported range', () => {
    expect(clampCamera({ x: 0, y: 0, zoom: 99 }, world).zoom).toBe(4)
    expect(clampCamera({ x: 0, y: 0, zoom: 0.01 }, world).zoom).toBe(0.25)
  })

  it('rejects non-finite camera values rather than emitting a broken viewBox', () => {
    expect(clampCamera({ x: Number.NaN, y: 0, zoom: 1 }, world)).toEqual(IDENTITY_CAMERA)
    expect(clampCamera({ x: 0, y: 0, zoom: Number.POSITIVE_INFINITY }, world)).toEqual(
      IDENTITY_CAMERA
    )
  })

  it('never lets the world leave the viewport entirely', () => {
    const far = clampCamera({ x: 99999, y: 99999, zoom: 1 }, world)

    // Some of the world must still overlap the visible window.
    expect(far.x).toBeLessThan(world.width)
    expect(far.y).toBeLessThan(world.height)

    const near = clampCamera({ x: -99999, y: -99999, zoom: 1 }, world)

    expect(near.x + world.width / near.zoom).toBeGreaterThan(0)
    expect(near.y + world.height / near.zoom).toBeGreaterThan(0)
  })

  it('zooms about a focal point, keeping that world point visually still', () => {
    const focal = { x: 500, y: 300 }
    const next = zoomAt(IDENTITY_CAMERA, world, focal, 2)

    const relBefore = {
      x: (focal.x - IDENTITY_CAMERA.x) / world.width,
      y: (focal.y - IDENTITY_CAMERA.y) / world.height
    }
    const relAfter = {
      x: (focal.x - next.x) / (world.width / next.zoom),
      y: (focal.y - next.y) / (world.height / next.zoom)
    }

    expect(relAfter.x).toBeCloseTo(relBefore.x, 5)
    expect(relAfter.y).toBeCloseTo(relBefore.y, 5)
  })

  it('pans in world units scaled by the current zoom', () => {
    // A 10px drag at 2x covers HALF the world distance of the same drag at 1x.
    const atOne = panCamera({ x: 100, y: 100, zoom: 1 }, world, { x: -10, y: -10 })
    const atTwo = panCamera({ x: 100, y: 100, zoom: 2 }, world, { x: -10, y: -10 })

    expect(atOne.x).toBeCloseTo(110, 5)
    expect(atTwo.x).toBeCloseTo(105, 5)
  })

  it('frames a node at the centre of the window', () => {
    const framed = cameraForNode({ x: 360, y: 210 }, world, 2)
    const centre = {
      x: framed.x + world.width / framed.zoom / 2,
      y: framed.y + world.height / framed.zoom / 2
    }

    expect(centre.x).toBeCloseTo(360, 5)
    expect(centre.y).toBeCloseTo(210, 5)
  })

  it('framing a node still respects the pan clamp', () => {
    const framed = cameraForNode({ x: 100000, y: 100000 }, world, 2)

    expect(Number.isFinite(framed.x)).toBe(true)
    expect(framed.x).toBeLessThan(world.width)
  })

  it('recognises the identity camera so the UI can hide the reset affordance', () => {
    expect(isIdentityCamera(IDENTITY_CAMERA)).toBe(true)
    expect(isIdentityCamera({ x: 0, y: 0, zoom: 1.0001 })).toBe(false)
    expect(isIdentityCamera({ x: 1, y: 0, zoom: 1 })).toBe(false)
  })

  it('treats a degenerate world as identity rather than dividing by zero', () => {
    expect(cameraViewBox(IDENTITY_CAMERA, { height: 0, width: 0 })).toBe('0 0 0 0')
    expect(clampCamera({ x: 5, y: 5, zoom: 2 }, { height: 0, width: 0 })).toEqual(IDENTITY_CAMERA)
  })
})
