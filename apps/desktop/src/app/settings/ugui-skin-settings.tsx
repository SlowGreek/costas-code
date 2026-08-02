import { type UguiDocument, validateUguiDocument } from '@hermes/shared/ugui-document'
import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { type UguiDocumentEvent, UguiDocumentPainter } from '@/app/ae-executive/document-painter'
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

interface SkinSettingsDocumentResponse {
  schema: 'ae-skin-settings-document/1'
  authority: 'none'
  projector: string
  document: UguiDocument
}

function parseSkinSettingsResponse(value: unknown): SkinSettingsDocumentResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('skin-settings-response')}
  const row = value as Record<string, unknown>

  if (
    Object.keys(row).length !== 4 ||
    row.schema !== 'ae-skin-settings-document/1' ||
    row.authority !== 'none' ||
    typeof row.projector !== 'string' ||
    !row.projector ||
    !row.document ||
    typeof row.document !== 'object' ||
    Array.isArray(row.document)
  ) {throw new Error('skin-settings-schema')}

  const document = validateUguiDocument(row.document)

  return { ...row, document } as unknown as SkinSettingsDocumentResponse
}

export function UguiSkinSettings() {
  const catalog = useStore($renderProfileCatalog)
  const loadingCatalog = useStore($renderProfileLoading)
  const catalogError = useStore($renderProfileError)
  const pending = useStore($renderProfilePending)
  const committedId = useStore($renderProfileCommittedId)
  const previewId = useStore($renderProfilePreviewId) ?? committedId
  const [document, setDocument] = useState<UguiDocument | null>(null)
  const [documentError, setDocumentError] = useState<string | null>(null)
  const [documentLoading, setDocumentLoading] = useState(false)

  useEffect(() => {
    if (!catalog) {void loadRenderProfileCatalog().catch(() => undefined)}
  }, [catalog])

  useEffect(() => {
    if (!catalog || !catalog.profiles.some(profile => profile.id === committedId) || !catalog.profiles.some(profile => profile.id === previewId)) {return}
    let live = true
    setDocumentLoading(true)
    setDocumentError(null)
    void window.hermesDesktop
      .getUguiSkinSettingsDocument({ committed_id: committedId, preview_id: previewId })
      .then(parseSkinSettingsResponse)
      .then(response => {
        if (live) {setDocument(response.document)}
      })
      .catch(error => {
        if (live) {
          setDocument(null)
          setDocumentError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (live) {setDocumentLoading(false)}
      })

    return () => {
      live = false
    }
  }, [catalog, committedId, previewId])

  const onEvent = (event: UguiDocumentEvent) => {
    if (event.document_id !== document?.id || event.payload !== null) {
      setDocumentError('skin-event-refused')

      return
    }

    const action = event.action

    if (action === 'skin.apply') {
      void applyRenderProfilePreview().then(ok => {
        if (!ok) {setDocumentError('skin-apply-refused')}
      })

      return
    }

    if (action === 'skin.revert') {
      if (!revertRenderProfilePreview()) {setDocumentError('skin-revert-refused')}

      return
    }

    if (action.startsWith('skin.preview.')) {
      const id = action.slice('skin.preview.'.length)

      if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(id) || !previewRenderProfile(id)) {
        setDocumentError('skin-preview-refused')
      }

      return
    }

    setDocumentError('skin-action-refused')
  }

  const busy = loadingCatalog || documentLoading || pending
  const error = catalogError || documentError

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
      ) : document ? (
        <div className="min-h-0" data-skin-settings-document>
          <UguiDocumentPainter document={document} onEvent={onEvent} />
        </div>
      ) : (
        <div className="grid min-h-64 place-items-center text-sm text-muted-foreground" role="status">
          {busy ? 'Projecting canonical UGUI skin settings…' : 'UGUI skin settings unavailable.'}
        </div>
      )}
    </div>
  )
}
