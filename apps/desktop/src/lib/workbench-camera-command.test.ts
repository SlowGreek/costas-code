import { describe, expect, it } from 'vitest'

import type { RealtimeCameraCommand } from './realtime-voice'
import { resolveWorkbenchCameraCommand } from './workbench-camera-command'

const layout = {
  height: 420,
  positions: {
    planner: { x: 180, y: 120 },
    executor: { x: 520, y: 300 },
    memory: { x: 360, y: 210 }
  },
  width: 720
}

const resolve = (
  command: RealtimeCameraCommand,
  camera = { x: 0, y: 0, zoom: 1 }
) => resolveWorkbenchCameraCommand(command, layout, camera)

describe('resolveWorkbenchCameraCommand', () => {
  it('places a node on the requested composition anchor', () => {
    const target = resolve({
      anchor: 'left',
      kind: 'zoom_to',
      nodeId: 'memory',
      transition: 'smooth',
      zoom: 2
    })

    expect(target).not.toBeNull()
    expect((360 - (target?.x ?? 0)) / (720 / (target?.zoom ?? 1))).toBeCloseTo(1 / 3, 5)
  })

  it('refuses a stale node target', () => {
    expect(
      resolve({
        anchor: 'center',
        kind: 'zoom_to',
        nodeId: 'missing',
        transition: 'smooth'
      })
    ).toBeNull()
  })

  it('frames a cluster only when every requested node exists', () => {
    expect(
      resolve({
        anchor: 'center',
        kind: 'frame_nodes',
        nodeIds: ['planner', 'executor'],
        padding: 'normal',
        transition: 'smooth'
      })
    ).not.toBeNull()
    expect(
      resolve({
        anchor: 'center',
        kind: 'frame_nodes',
        nodeIds: ['planner', 'missing'],
        padding: 'normal',
        transition: 'smooth'
      })
    ).toBeNull()
  })

  it('pans relative to the current camera without changing zoom', () => {
    const target = resolve(
      { amount: 'medium', direction: 'right', kind: 'pan_view', transition: 'smooth' },
      { x: 100, y: 80, zoom: 2 }
    )

    expect(target?.x).toBeGreaterThan(100)
    expect(target?.zoom).toBe(2)
  })

  it('zooms around the current composition centre', () => {
    const target = resolve(
      { amount: 'small', direction: 'out', kind: 'zoom_view', transition: 'quick' },
      { x: 180, y: 105, zoom: 2 }
    )

    expect(target?.zoom).toBeLessThan(2)
    expect(target?.zoom).toBeGreaterThanOrEqual(0.25)
  })

  it('resets to the whole canvas', () => {
    expect(resolve({ kind: 'reset_view', transition: 'dramatic' })).toEqual({
      x: 0,
      y: 0,
      zoom: 1
    })
  })
})
