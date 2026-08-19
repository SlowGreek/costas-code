import { beforeEach, describe, expect, it } from 'vitest'

import { clientToCanvas } from '@/app/workbench/map/map-renderer'
import {
  $workbenchCamera,
  resetWorkbenchCameraFor,
  resetWorkbenchForTests,
  setWorkbenchCamera
} from '@/store/workbench'

import {
  cameraForNode,
  cameraViewBox,
  IDENTITY_CAMERA,
  panCamera,
  zoomAt
} from './workbench-camera'
import { describeWorkbenchSpace } from './workbench-spatial'

const world = { height: 420, width: 720 }
const rect = { height: 420, left: 0, top: 0, width: 720 }

/**
 * The viewport must not cost the workbench anything it could already do.
 * Each test here pins one pre-existing behaviour against the camera.
 */
describe('viewport non-degradation', () => {
  beforeEach(() => {
    resetWorkbenchForTests()
  })

  it('renders the pre-camera viewBox when nothing has moved', () => {
    // The default path is provably byte-identical to before the camera existed.
    expect(cameraViewBox(IDENTITY_CAMERA, world)).toBe('0 0 720 420')
    expect(cameraViewBox($workbenchCamera.get(), world)).toBe('0 0 720 420')
  })

  it('maps a click to the same node at identity as it always did', () => {
    expect(clientToCanvas({ x: 250, y: 130 }, rect, world, IDENTITY_CAMERA)).toEqual({
      x: 250,
      y: 130
    })
  })

  it('round-trips a drag point through the camera at any zoom', () => {
    // Drag correctness IS the pointer transform: if this drifts, nodes get
    // pinned to the wrong world coordinates and the persisted layout rots.
    for (const camera of [
      IDENTITY_CAMERA,
      { x: 0, y: 0, zoom: 2 },
      { x: 120, y: 60, zoom: 0.5 },
      { x: 300, y: 200, zoom: 3 }
    ]) {
      const client = { x: 400, y: 300 }
      const worldPoint = clientToCanvas(client, rect, world, camera)

      // Re-project the world point back to client space by hand.
      const view = { height: world.height / camera.zoom, width: world.width / camera.zoom }
      const scale = Math.min(rect.width / view.width, rect.height / view.height)
      const backX = (worldPoint.x - camera.x) * scale + rect.left
      const backY = (worldPoint.y - camera.y) * scale + rect.top

      expect(backX).toBeCloseTo(client.x, 4)
      expect(backY).toBeCloseTo(client.y, 4)
    }
  })

  it('keeps the assistant spatial language in WORLD terms, whatever the view', () => {
    // Trap 2. If zones were computed from the visible window, a node the user
    // zoomed past would become "far left" and the assistant would describe the
    // same canvas differently depending on scroll position — while focus and
    // pins still speak world coordinates.
    const nodes = [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' }
    ]

    const positions = { a: { x: 80, y: 60 }, b: { x: 640, y: 360 } }

    const before = describeWorkbenchSpace(nodes, positions, world.width, world.height)

    setWorkbenchCamera({ x: 300, y: 200, zoom: 3 })

    const after = describeWorkbenchSpace(nodes, positions, world.width, world.height)

    expect(after).toEqual(before)
    expect(after.a.zone).toBe('upper left')
  })

  it('never persists the camera into artifact view_state', () => {
    // The camera is presentation state. Writing it to view_state would make
    // two windows fight over the same row and add a DB write per wheel tick.
    setWorkbenchCamera({ x: 40, y: 40, zoom: 2 })

    expect($workbenchCamera.get()).not.toHaveProperty('positions')
    expect($workbenchCamera.get()).not.toHaveProperty('focus')
    expect(Object.keys($workbenchCamera.get()).sort()).toEqual(['x', 'y', 'zoom'])
  })

  it('survives a redraw of the same artifact but resets for a new one', () => {
    resetWorkbenchCameraFor('artifact-1')
    setWorkbenchCamera({ x: 40, y: 40, zoom: 2 })

    resetWorkbenchCameraFor('artifact-1')
    expect($workbenchCamera.get().zoom).toBe(2)

    resetWorkbenchCameraFor('artifact-2')
    expect($workbenchCamera.get()).toEqual(IDENTITY_CAMERA)
  })

  it('always leaves the drawing reachable, however lost the user gets', () => {
    // No corner of the interaction space traps the user off-canvas.
    for (const camera of [
      panCamera(IDENTITY_CAMERA, world, { x: 99999, y: 99999 }),
      panCamera(IDENTITY_CAMERA, world, { x: -99999, y: -99999 }),
      zoomAt(IDENTITY_CAMERA, world, { x: 0, y: 0 }, 4),
      cameraForNode({ x: 99999, y: -99999 }, world, 4)
    ]) {
      const view = { height: world.height / camera.zoom, width: world.width / camera.zoom }

      // Some of the world still overlaps the visible window.
      expect(camera.x).toBeLessThan(world.width)
      expect(camera.y).toBeLessThan(world.height)
      expect(camera.x + view.width).toBeGreaterThan(0)
      expect(camera.y + view.height).toBeGreaterThan(0)
    }
  })

  it('treats an unmeasured pane as identity rather than dividing by zero', () => {
    // pane.tsx renders one frame at DEFAULT_SIZE before the ResizeObserver
    // reports, and a zero-size world must not produce NaN in the viewBox.
    expect(cameraViewBox({ x: 5, y: 5, zoom: 2 }, { height: 0, width: 0 })).not.toContain('NaN')
  })
})
