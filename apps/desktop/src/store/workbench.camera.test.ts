import { beforeEach, describe, expect, it } from 'vitest'

import { IDENTITY_CAMERA } from '@/lib/workbench-camera'

import {
  $workbenchCamera,
  clearWorkbenchForSessionTransition,
  resetWorkbenchCameraFor,
  resetWorkbenchForTests,
  setWorkbenchCamera
} from './workbench'

describe('workbench camera store', () => {
  beforeEach(() => {
    resetWorkbenchForTests()
  })

  it('starts at identity', () => {
    expect($workbenchCamera.get()).toEqual(IDENTITY_CAMERA)
  })

  it('holds a camera the user moved', () => {
    setWorkbenchCamera({ x: 40, y: 20, zoom: 2 })

    expect($workbenchCamera.get()).toEqual({ x: 40, y: 20, zoom: 2 })
  })

  it('resets when the artifact identity changes', () => {
    resetWorkbenchCameraFor('artifact-a')
    setWorkbenchCamera({ x: 100, y: 100, zoom: 2 })
    resetWorkbenchCameraFor('artifact-b')

    expect($workbenchCamera.get()).toEqual(IDENTITY_CAMERA)
  })

  it('does NOT reset on a redraw of the same artifact', () => {
    // The load-bearing test. A `visualize` redraw yanking the user's view back
    // to fit mid-conversation would be a new, worse stutter than the one the
    // fire-and-forget change removed.
    resetWorkbenchCameraFor('artifact-a')
    setWorkbenchCamera({ x: 40, y: 0, zoom: 3 })
    resetWorkbenchCameraFor('artifact-a')

    expect($workbenchCamera.get().zoom).toBe(3)
    expect($workbenchCamera.get().x).toBe(40)
  })

  it('resets when the canvas is cleared', () => {
    resetWorkbenchCameraFor('artifact-a')
    setWorkbenchCamera({ x: 40, y: 0, zoom: 3 })
    resetWorkbenchCameraFor(null)

    expect($workbenchCamera.get()).toEqual(IDENTITY_CAMERA)
  })

  it('does not leak a camera across a session transition', () => {
    resetWorkbenchCameraFor('artifact-a')
    setWorkbenchCamera({ x: 40, y: 0, zoom: 3 })

    clearWorkbenchForSessionTransition()

    expect($workbenchCamera.get()).toEqual(IDENTITY_CAMERA)
  })

  it('preserves reference identity when nothing changed', () => {
    setWorkbenchCamera({ x: 10, y: 10, zoom: 2 })
    const first = $workbenchCamera.get()

    setWorkbenchCamera({ x: 10, y: 10, zoom: 2 })

    // Handing React a fresh object for identical data re-renders the canvas
    // for nothing — and this fires on every wheel tick.
    expect($workbenchCamera.get()).toBe(first)
  })

  it('is cleared by the test reset helper', () => {
    setWorkbenchCamera({ x: 10, y: 10, zoom: 2 })
    resetWorkbenchForTests()

    expect($workbenchCamera.get()).toEqual(IDENTITY_CAMERA)
  })
})
