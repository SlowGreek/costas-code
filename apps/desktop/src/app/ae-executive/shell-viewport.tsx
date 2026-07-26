import { useEffect, useRef, useState } from 'react'

import { type AeExecutiveScene, validateExecutiveScene } from '@/app/ae-executive/scene'
import { AeScenePainter, type UguiSceneEvent } from '@/app/ae-executive/scene-painter'

interface ShellViewportResponse {
  schema: 'ae-shell-viewport-scene/1'
  authority: 'none'
  model: {
    shell: { id: string }
    surface: { id: string }
    target: { id: string }
    selector: { shells: string[]; surfaces: string[]; targets: string[] }
  }
  scene: AeExecutiveScene
}

const DEFAULT_SELECTION = {
  shell_id: 'android-shell',
  surface_profile_id: 'google-pixel-9',
  target_id: 'android-arm64-v8a'
}

function parse(value: unknown): ShellViewportResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('shell-viewport-response')}
  const row = value as Record<string, unknown>

  if (row.schema !== 'ae-shell-viewport-scene/1' || row.authority !== 'none' || !row.model || !row.scene) {
    throw new Error('shell-viewport-schema')
  }

  const scene = row.scene as AeExecutiveScene
  validateExecutiveScene(scene)

  return row as unknown as ShellViewportResponse
}

export function AeShellViewport() {
  const [selection, setSelection] = useState(DEFAULT_SELECTION)
  const [response, setResponse] = useState<ShellViewportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    const token = ++generation.current
    setError(null)
    void window.hermesDesktop
      .getShellViewportScene(selection)
      .then(parse)
      .then(next => {
        if (token === generation.current) {setResponse(next)}
      })
      .catch(cause => {
        if (token === generation.current) {setError(cause instanceof Error ? cause.message : String(cause))}
      })
  }, [selection])

  const onEvent = (event: UguiSceneEvent) => {
    if (event.scene_id !== 'shell-viewport' || event.payload !== null || event.gesture !== 'tap') {
      setError('shell-viewport-event-refused')

      return
    }

    if (event.action === 'shell.inspect') {return}
    const [family, kind, id, ...extra] = event.action.split('.')

    if (family !== 'shell' || extra.length || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id ?? '')) {
      setError('shell-viewport-action-refused')

      return
    }

    if (kind === 'surface' && response?.model.selector.surfaces.includes(id)) {
      setSelection(current => ({ ...current, surface_profile_id: id }))

      return
    }

    if (kind === 'build' && response?.model.selector.targets.includes(id)) {
      setSelection(current => ({ ...current, target_id: id }))

      return
    }

    if (kind === 'target' && response?.model.selector.shells.includes(id)) {
      const defaults: Record<string, { surface_profile_id: string; target_id: string }> = {
        'android-shell': { surface_profile_id: 'google-pixel-9', target_id: 'android-arm64-v8a' },
        'macos-shell': { surface_profile_id: 'macos-desktop', target_id: 'macos-arm64' }
      }

      const next = defaults[id]

      if (next) {setSelection({ shell_id: id, ...next })}
      else {setError('shell-viewport-shell-unavailable')}

      return
    }

    setError('shell-viewport-action-refused')
  }

  if (error) {
    return <section className="rounded-xl border border-destructive/50 bg-destructive/5 p-5 font-mono text-sm text-destructive">SHELL viewport refused · {error}</section>
  }

  if (!response) {
    return <section className="rounded-xl border border-(--ui-stroke-tertiary) p-5 font-mono text-sm text-(--ui-text-tertiary)">Projecting SHELL constraints…</section>
  }

  return <AeScenePainter onEvent={onEvent} scene={response.scene} />
}
