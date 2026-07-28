import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { cn } from '@/lib/utils'

import { aeExecutiveTab, isAeExecutiveTabId } from './contract'
import {
  applyLucidActionPosture,
  createLucidActionCoordinator,
  lucidActionContext,
  type LucidActionContext,
  lucidActionForHandler
} from './lucid-actions'
import {
  type AeExecutiveSceneBatch,
  loadExecutiveScenes,
  reconcileExecutiveBatch,
  studioDesignerContext
} from './scene'
import { AeScenePainter, type UguiSceneEvent } from './scene-painter'

const EXECUTIVE_RECONCILE_INTERVAL_MS = 1_000

export function AeExecutiveWorkspace() {
  const navigate = useNavigate()
  const params = useParams<{ tab?: string }>()
  const [batch, setBatch] = useState<AeExecutiveSceneBatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('Loading Rust UGUI projection…')
  const batchRef = useRef<AeExecutiveSceneBatch | null>(null)
  const lucidContextRef = useRef<LucidActionContext>({ generation: 0, documentHash: '', posture: 'held' })
  const lucidCoordinatorRef = useRef<ReturnType<typeof createLucidActionCoordinator> | null>(null)

  lucidCoordinatorRef.current ??= createLucidActionCoordinator(
    request => window.hermesDesktop.executeLucidExecutiveIntent(request),
    () => lucidContextRef.current
  )

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let inFlight = false

    const schedule = () => {
      if (!active) {return}
      timer = setTimeout(reconcile, EXECUTIVE_RECONCILE_INTERVAL_MS)
    }

    const reconcile = async () => {
      if (!active || inFlight) {return}
      inFlight = true

      try {
        const incoming = await loadExecutiveScenes()

        if (!active) {return}
        const result = reconcileExecutiveBatch(batchRef.current, incoming)

        if (result.accepted) {
          batchRef.current = result.batch
          setBatch(result.batch)
          setError(null)
          setNotice(
            result.reason === 'duplicate'
              ? `Generation ${displayGeneration(result.batch)} unchanged · exact duplicate`
              : `Generation ${displayGeneration(result.batch)} admitted · independent tab rows reconciled`
          )
        } else {
          setNotice(
            `Reconciliation refused · ${result.reason} · showing generation ${displayGeneration(result.batch)}`
          )
        }
      } catch (reason) {
        if (!active) {return}
        const message = reason instanceof Error ? reason.message : 'ae-executive-projector-unavailable'

        if (!batchRef.current) {
          setError(message)
          setNotice('Scene unavailable · reconciliation will retry')
        } else {
          setNotice(`Reconciliation degraded · ${message} · showing last valid rows`)
        }
      } finally {
        inFlight = false
        schedule()
      }
    }

    void reconcile()

    return () => {
      active = false

      if (timer !== null) {clearTimeout(timer)}
    }
  }, [])

  const requestedTab = params.tab ?? ''
  const requestedRow = batch?.scenes.find(row => row.tab === requestedTab)
  const tabId = requestedRow ? requestedTab : aeExecutiveTab(requestedTab).id
  const selectedRow = batch?.scenes.find(row => row.tab === tabId)
  const sourceScene = selectedRow?.scene ?? null

  const lucidContext = batch && sourceScene && tabId === 'lucid'
    ? lucidActionContext(batch, sourceScene)
    : { generation: 0, documentHash: '', posture: 'held' as const }

  const scene = sourceScene && tabId === 'lucid'
    ? applyLucidActionPosture(sourceScene, lucidContext)
    : sourceScene

  lucidContextRef.current = lucidContext

  const selectedStatus = selectedRow
    ? `${selectedRow.tab} ${selectedRow.state}${selectedRow.preserved ? ' · last valid Scene preserved' : ''}${selectedRow.reason ? ` · ${selectedRow.reason}` : ''}`
    : null

  const onAction = useCallback(
    async (action: string) => {
      const shellTab = action.match(/^shell\.tab\.([a-z0-9][a-z0-9-]{0,127})$/)?.[1]

      const admitted = shellTab && (
        batch?.scenes.some(row => row.tab === shellTab) ||
        (isAeExecutiveTabId(shellTab) && shellTab === 'shell')
      )

      if (shellTab && admitted) {
        navigate(`/ae/${shellTab}`)

        return
      }

      const lucid = lucidActionForHandler(action)

      if (lucid) {
        setNotice(`LUCID ${lucid.verb.toUpperCase()} · awaiting Butler receipt`)
        const result = await lucidCoordinatorRef.current!.run(action)

        if ('lucid_receipt' in result) {
          const receipt = result.lucid_receipt
          const status = receipt.ran ? 'executed' : receipt.needs_user ? 'confirmation required' : 'refused'

          setNotice(`LUCID ${receipt.verb.toUpperCase()} · ${status} · receipt ${receipt.id}`)
        } else {
          setNotice(`LUCID ${lucid.verb.toUpperCase()} · ${result.code} · not retried`)
        }

        return
      }

      setNotice('Intent refused · handler is outside the closed executive navigation/LUCID registry')
    },
    [batch, navigate]
  )

  const onSceneEvent = useCallback(
    async (event: UguiSceneEvent) => {
      if (event.action.startsWith('shell.tab.')) {
        await onAction(event.action)

        return
      }

      if (tabId === 'shell' && event.action.startsWith('shell.')) {
        setNotice(
          `SHELL intent routed · ${event.action} · revision ${event.revision} · awaiting canonical RUN reduction; host state unchanged`
        )

        return
      }

      if (tabId !== 'studio' || !scene) {
        await onAction(event.action)

        return
      }

      const context = studioDesignerContext(scene)

      if (!context) {
        setNotice('STUDIO intent refused · exact editor revision/hash unavailable')

        return
      }

      setNotice(`STUDIO ${event.action} · awaiting resident RUN receipt`)

      try {
        const receipt = await window.hermesDesktop.submitStudioDesignerEvent({ event, context })

        setNotice(
          `STUDIO ${receipt.status} · ${receipt.code} · revision ${receipt.revision} · ${receipt.status === 'accepted' ? 'reconciling both shells' : 'not applied'}`
        )
      } catch (reason) {
        const code = reason instanceof Error ? reason.message : 'studio-action-outcome-unknown'

        setNotice(`STUDIO outcome unknown/refused · ${code} · not retried`)
      }
    },
    [onAction, scene, tabId]
  )

  const trust = batch
    ? `Generation ${displayGeneration(batch)} · authority ${batch.authority} · observed ${batch.observed_ms ?? 'unverified'} · freshness ${batch.freshness} · posture ${batch.posture} · artifact ${batch.artifact_generation}`
    : notice

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-ae-executive-tab={tabId}>
      <main className="min-h-0 flex-1 overflow-hidden p-3">
        <div className="mx-auto h-full min-h-0 w-full max-w-7xl">
          {scene ? (
            <div className="flex h-full min-h-0 flex-col gap-2">
              {selectedRow && selectedRow.state !== 'fresh' ? (
                <div
                  aria-live="polite"
                  className="shrink-0 rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 font-mono text-xs text-amber-700"
                  data-ae-scene-posture={selectedRow.state}
                  role="status"
                >
                  UGUI Scene {selectedRow.state} · {selectedRow.reason ?? 'producer posture'}
                  {selectedRow.preserved ? ' · last valid Scene preserved' : ''}
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                <AeScenePainter onAction={onAction} onEvent={onSceneEvent} scene={scene} />
              </div>
            </div>
          ) : error ? (
            <section className="rounded-xl border border-destructive/50 bg-destructive/5 p-5 font-mono text-sm text-destructive">
              UGUI Scene unavailable · {error}
            </section>
          ) : selectedRow ? (
            <section className="rounded-xl border border-amber-500/50 bg-amber-500/5 p-5 font-mono text-sm text-amber-700">
              UGUI Scene unavailable · {selectedRow.reason ?? selectedRow.state}
            </section>
          ) : (
            <section className="rounded-xl border border-(--ui-stroke-tertiary) p-5 font-mono text-sm text-(--ui-text-tertiary)">
              Projecting through RUN + Rust UGUI…
            </section>
          )}
        </div>
      </main>

      <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-(--ui-stroke-tertiary) px-4 text-[0.65rem] text-(--ui-text-quaternary)">
        <span
          aria-hidden="true"
          className={cn('size-1.5 rounded-full', scene ? 'bg-sky-500' : 'bg-amber-500')}
          data-ugui-structural-status
        />
        <span aria-live="polite" data-ae-trust-footer>{trust}</span>
        <span className="truncate" data-ae-reconcile-notice>
          · {notice}
        </span>
        {selectedStatus && <span className="truncate">· {selectedStatus}</span>}
        <span className="ml-auto shrink-0">RUN facts · UGUI composition/layout · Desktop paint</span>
      </footer>
    </div>
  )
}

function displayGeneration(batch: AeExecutiveSceneBatch): string {
  return batch.generation === null ? 'legacy/unverified' : String(batch.generation)
}
