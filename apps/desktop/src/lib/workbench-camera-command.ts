import type { RealtimeCameraCommand } from './realtime-voice'
import {
  cameraForNode,
  cameraForPoints,
  IDENTITY_CAMERA,
  panCamera,
  type WorkbenchCamera,
  zoomAt
} from './workbench-camera'

interface WorkbenchCameraLayout {
  height: number
  positions: Record<string, { x: number; y: number }>
  width: number
}

const PAN_PIXELS = { large: 280, medium: 160, small: 80 } as const
const ZOOM_FACTORS = { large: 2, medium: 1.5, small: 1.2 } as const
const FRAME_PADDING = { tight: 55, normal: 90, wide: 140 } as const

export function resolveWorkbenchCameraCommand(
  command: RealtimeCameraCommand,
  layout: WorkbenchCameraLayout,
  camera: WorkbenchCamera
): null | WorkbenchCamera {
  const world = { height: layout.height, width: layout.width }

  if (command.kind === 'reset_view') {
    return { ...IDENTITY_CAMERA }
  }

  if (command.kind === 'zoom_to') {
    const point = layout.positions[command.nodeId]

    return point
      ? cameraForNode(point, world, command.zoom ?? 2, command.anchor)
      : null
  }

  if (command.kind === 'frame_nodes') {
    const points = command.nodeIds.map(nodeId => layout.positions[nodeId])

    if (points.some(point => !point)) {
      return null
    }

    return cameraForPoints(
      points as { x: number; y: number }[],
      world,
      FRAME_PADDING[command.padding],
      command.anchor
    )
  }

  if (command.kind === 'pan_view') {
    if (command.requireNodeId && !layout.positions[command.requireNodeId]) {
      return null
    }

    const distance = PAN_PIXELS[command.amount]

    const delta =
      command.direction === 'left'
        ? { x: distance, y: 0 }
        : command.direction === 'right'
          ? { x: -distance, y: 0 }
          : command.direction === 'up'
            ? { x: 0, y: distance }
            : { x: 0, y: -distance }

    return panCamera(camera, world, delta)
  }

  const factor = ZOOM_FACTORS[command.amount]

  const centre = {
    x: camera.x + world.width / camera.zoom / 2,
    y: camera.y + world.height / camera.zoom / 2
  }

  const zoom = command.direction === 'in' ? camera.zoom * factor : camera.zoom / factor

  return zoomAt(camera, world, centre, zoom)
}
