import type { AeExecutiveScene } from './scene'
import { AeScenePainter, type UguiSceneEvent } from './scene-painter'

interface AeShellViewportProps {
  scene: AeExecutiveScene
  onEvent?: (event: UguiSceneEvent) => void
}

/**
 * Paints the producer-owned SHELL Scene without deriving shell chrome or state in React.
 * The workspace normally invokes AeScenePainter directly; this named adapter remains for
 * focused consumers that need to identify the recursive SHELL boundary.
 */
export function AeShellViewport({ onEvent, scene }: AeShellViewportProps) {
  return <AeScenePainter onEvent={onEvent} scene={scene} />
}
