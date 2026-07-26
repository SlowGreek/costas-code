import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { type AeExecutiveScene, validateExecutiveScene } from '@/app/ae-executive/scene'
import { AeScenePainter, type UguiSceneEvent } from '@/app/ae-executive/scene-painter'
import { Button } from '@/components/ui/button'
import { Loader2, RefreshCw } from '@/lib/icons'
import {
  $renderProfileCatalog,
  $renderProfileCommittedId,
  $renderProfileError,
  $renderProfileLoading,
  $renderProfilePending,
  $renderProfilePreviewId,
  applyRenderProfilePreview,
  loadRenderProfileCatalog,
  previewRenderProfile,
  revertRenderProfilePreview
} from '@/store/render-profile'

interface SkinSettingsResponse {
  schema: 'ae-skin-settings-scene/1'
  authority: 'none'
  projector: string
  scene: AeExecutiveScene
}

function parseSkinSettingsResponse(value: unknown): SkinSettingsResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('skin-settings-response')}
  const row = value as Record<string, unknown>

  if (
    Object.keys(row).length !== 4 ||
    row.schema !== 'ae-skin-settings-scene/1' ||
    row.authority !== 'none' ||
    typeof row.projector !== 'string' ||
    !row.projector ||
    !row.scene ||
    typeof row.scene !== 'object' ||
    Array.isArray(row.scene)
  ) {throw new Error('skin-settings-schema')}

  const scene = row.scene as AeExecutiveScene
  validateExecutiveScene(scene)

  return row as unknown as SkinSettingsResponse
}

export function UguiSkinSettings() {
  const catalog = useStore($renderProfileCatalog)
  const loadingCatalog = useStore($renderProfileLoading)
  const catalogError = useStore($renderProfileError)
  const pending = useStore($renderProfilePending)
  const committedId = useStore($renderProfileCommittedId)
  const previewId = useStore($renderProfilePreviewId) ?? committedId
  const [scene, setScene] = useState<AeExecutiveScene | null>(null)
  const [sceneError, setSceneError] = useState<string | null>(null)
  const [sceneLoading, setSceneLoading] = useState(false)

  useEffect(() => {
    if (!catalog) {void loadRenderProfileCatalog().catch(() => undefined)}
  }, [catalog])

  useEffect(() => {
    if (!catalog || !catalog.profiles.some(profile => profile.id === committedId) || !catalog.profiles.some(profile => profile.id === previewId)) {return}
    let live = true
    setSceneLoading(true)
    setSceneError(null)
    void window.hermesDesktop
      .getUguiSkinSettingsScene({ committed_id: committedId, preview_id: previewId })
      .then(parseSkinSettingsResponse)
      .then(response => {
        if (live) {setScene(response.scene)}
      })
      .catch(error => {
        if (live) {
          setScene(null)
          setSceneError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (live) {setSceneLoading(false)}
      })

    return () => {
      live = false
    }
  }, [catalog, committedId, previewId])

  const onEvent = (event: UguiSceneEvent) => {
    if (event.scene_id !== (scene?.id ?? scene?.root) || event.revision !== 0 || event.payload !== null) {
      setSceneError('skin-event-refused')

      return
    }

    const action = event.action

    if (action === 'skin.apply') {
      void applyRenderProfilePreview().then(ok => {
        if (!ok) {setSceneError('skin-apply-refused')}
      })

      return
    }

    if (action === 'skin.revert') {
      if (!revertRenderProfilePreview()) {setSceneError('skin-revert-refused')}

      return
    }

    if (action.startsWith('skin.preview.')) {
      const id = action.slice('skin.preview.'.length)

      if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(id) || !previewRenderProfile(id)) {
        setSceneError('skin-preview-refused')
      }

      return
    }

    setSceneError('skin-action-refused')
  }

  const busy = loadingCatalog || sceneLoading || pending
  const error = catalogError || sceneError

  return (
    <div className="grid min-h-[28rem] gap-3" data-testid="ugui-skin-settings">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold">UGUI Skin Projection</div>
          <div className="text-xs text-muted-foreground">
            Canonical eight-axis profiles. Visual attestation remains pending until packaged renderer evidence passes.
          </div>
        </div>
        <Button disabled={busy} onClick={() => void loadRenderProfileCatalog()} size="sm" variant="secondary">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Refresh
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 font-mono text-xs text-destructive" role="alert">
          UGUI skin settings refused · {error}
        </div>
      ) : scene ? (
        <div className="min-h-0" data-skin-settings-scene>
          <AeScenePainter onEvent={onEvent} scene={scene} />
        </div>
      ) : (
        <div className="grid min-h-64 place-items-center text-sm text-muted-foreground" role="status">
          {busy ? 'Projecting canonical UGUI skin settings…' : 'UGUI skin settings unavailable.'}
        </div>
      )}
    </div>
  )
}
