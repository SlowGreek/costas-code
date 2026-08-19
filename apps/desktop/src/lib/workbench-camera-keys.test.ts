import { describe, expect, it } from 'vitest'

import { cameraFromKey, IDENTITY_CAMERA, isIdentityCamera } from './workbench-camera'

const world = { height: 420, width: 720 }

describe('cameraFromKey', () => {
  it('zooms in and out about the canvas centre', () => {
    const inward = cameraFromKey(IDENTITY_CAMERA, world, '+')
    const outward = cameraFromKey(IDENTITY_CAMERA, world, '-')

    expect(inward?.zoom).toBeGreaterThan(1)
    expect(outward?.zoom).toBeLessThan(1)
  })

  it('accepts = as zoom in, because + needs shift on most layouts', () => {
    expect(cameraFromKey(IDENTITY_CAMERA, world, '=')?.zoom).toBeGreaterThan(1)
  })

  it('resets to identity on 0', () => {
    const moved = { x: 200, y: 100, zoom: 3 }

    expect(isIdentityCamera(cameraFromKey(moved, world, '0')!)).toBe(true)
  })

  it('pans with the arrow keys', () => {
    const start = { x: 200, y: 100, zoom: 2 }

    expect(cameraFromKey(start, world, 'ArrowRight')!.x).toBeGreaterThan(start.x)
    expect(cameraFromKey(start, world, 'ArrowLeft')!.x).toBeLessThan(start.x)
    expect(cameraFromKey(start, world, 'ArrowDown')!.y).toBeGreaterThan(start.y)
    expect(cameraFromKey(start, world, 'ArrowUp')!.y).toBeLessThan(start.y)
  })

  it('returns null for keys it does not own', () => {
    // Escape must keep its single meaning (clear selection) — the cancel
    // gesture does exactly one thing, so reset lives on 0 instead.
    expect(cameraFromKey(IDENTITY_CAMERA, world, 'Escape')).toBeNull()
    expect(cameraFromKey(IDENTITY_CAMERA, world, 'a')).toBeNull()
    expect(cameraFromKey(IDENTITY_CAMERA, world, 'Enter')).toBeNull()
  })

  it('keeps zoom within range when held down', () => {
    let camera = IDENTITY_CAMERA

    for (let i = 0; i < 50; i += 1) {
      camera = cameraFromKey(camera, world, '+')!
    }

    expect(camera.zoom).toBeLessThanOrEqual(4)

    for (let i = 0; i < 50; i += 1) {
      camera = cameraFromKey(camera, world, '-')!
    }

    expect(camera.zoom).toBeGreaterThanOrEqual(0.25)
  })

  it('always leaves a way back to identity from anywhere', () => {
    // Never trap the user at 4x in a corner.
    const lost = { x: 99999, y: 99999, zoom: 4 }

    expect(isIdentityCamera(cameraFromKey(lost, world, '0')!)).toBe(true)
  })
})
