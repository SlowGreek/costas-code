import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { cn } from '@/lib/utils'

import { aeExecutiveTab } from './contract'
import { type AeExecutiveSceneBatch, loadExecutiveScenes, sceneForTab } from './scene'
import { AeScenePainter } from './scene-painter'
import { AeShellViewport } from './shell-viewport'

export function AeExecutiveWorkspace() {
  const navigate = useNavigate()
  const params = useParams<{ tab?: string }>()
  const [batch, setBatch] = useState<AeExecutiveSceneBatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('Loading Rust UGUI projection…')

  useEffect(() => {
    let active = true
    loadExecutiveScenes()
      .then(value => {
        if (!active) {return}
        setBatch(value)
        setError(null)
        setNotice(`Rendered · structure valid · authority ${value.authority} · freshness unverified`)
      })
      .catch(reason => {
        if (!active) {return}
        setError(reason instanceof Error ? reason.message : 'ae-executive-projector-unavailable')
        setNotice('Scene unavailable · no local semantic fallback')
      })

    return () => {
      active = false
    }
  }, [])

  const onAction = useCallback(
    (action: string) => {
      const shellTab = action.match(/^shell\.tab\.(.+)$/)?.[1]
      const route = action.match(/^quine-route:(.+)$/)?.[1]

      if (shellTab && batch?.scenes.some(row => row.tab === shellTab)) {
        navigate(`/ae/${shellTab}`)

        return
      }

      if (route && batch?.scenes.some(row => row.tab === route)) {
        navigate(`/ae/${route}`)

        return
      }

      setNotice(`Intent captured · ${action} · no effect without Butler receipt`)
    },
    [batch, navigate]
  )

  const requestedTab = params.tab ?? ''
  const shellRequested = requestedTab === 'shell'
  const tabId = batch?.scenes.some(row => row.tab === requestedTab) ? requestedTab : aeExecutiveTab(requestedTab).id
  const scene = batch ? sceneForTab(batch, tabId) : null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-ae-executive-tab={tabId}>
      <main className="min-h-0 flex-1 overflow-hidden p-3">
        <div className="mx-auto h-full min-h-0 w-full max-w-7xl">
          {shellRequested ? (
            <AeShellViewport />
          ) : scene ? (
            <AeScenePainter onAction={onAction} scene={scene} />
          ) : error ? (
            <section className="rounded-xl border border-destructive/50 bg-destructive/5 p-5 font-mono text-sm text-destructive">
              UGUI Scene unavailable · {error}
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
          className={cn('size-1.5 rounded-full', scene || shellRequested ? 'bg-sky-500' : 'bg-amber-500')}
          data-ugui-structural-status
        />
        <span aria-live="polite">{shellRequested ? 'Rendered · structural shell projection · physical evidence not implied' : notice}</span>
        <span className="ml-auto">RUN facts · UGUI composition/layout · Desktop paint</span>
      </footer>
    </div>
  )
}
