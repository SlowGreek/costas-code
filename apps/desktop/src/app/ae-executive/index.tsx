import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'

import { AE_EXECUTIVE_TABS, aeExecutiveTab, isAeExecutiveTabId } from './contract'
import { type AeExecutiveSceneBatch, loadExecutiveScenes, sceneForTab } from './scene'
import { AeScenePainter } from './scene-painter'

export function AeExecutiveWorkspace() {
  const navigate = useNavigate()
  const params = useParams<{ tab?: string }>()
  const tab = aeExecutiveTab(params.tab)
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
        setNotice(`Scene ready · ${value.projector} · authority ${value.authority}`)
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
      const route = action.match(/^quine-route:(.+)$/)?.[1]

      if (route && isAeExecutiveTabId(route)) {
        navigate(`/ae/${route}`)

        return
      }

      setNotice(`Intent captured · ${action} · no effect without Butler receipt`)
    },
    [navigate]
  )

  const scene = batch ? sceneForTab(batch, tab.id) : null

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-ae-executive-tab={tab.id}>
      <header className="shrink-0 border-b border-(--ui-stroke-tertiary) bg-(--ui-chat-surface-background)">
        <div className="flex h-10 items-center gap-2 px-4">
          <div className="flex size-5 items-center justify-center rounded bg-(--ui-bg-quinary) text-(--theme-primary)">
            <Codicon name="beaker" size="0.8rem" />
          </div>
          <span className="text-xs font-semibold tracking-wide text-foreground">AE EXECUTIVE</span>
          <span className="text-[0.65rem] text-(--ui-text-quaternary)">Rust UGUI projector</span>
          <span className="ml-auto font-mono text-[0.62rem] text-(--ui-text-quaternary)">
            {scene ? scene.root : 'projecting'}
          </span>
        </div>
        <nav aria-label="AgentExperiments executive tabs" className="flex min-w-0 overflow-x-auto px-2">
          {AE_EXECUTIVE_TABS.map(item => (
            <button
              aria-current={item.id === tab.id ? 'page' : undefined}
              className={cn(
                'shrink-0 border-b-2 border-transparent px-2.5 py-2 font-mono text-[0.68rem] text-(--ui-text-tertiary) transition-colors hover:text-foreground',
                item.id === tab.id && 'border-(--theme-primary) text-foreground'
              )}
              key={item.id}
              onClick={() => navigate(item.route)}
              title={`${item.label} · ${item.summary}`}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        <div className="mx-auto grid w-full max-w-5xl gap-4 px-5 py-5">
          <div className="flex items-start gap-3">
            <Codicon className="mt-0.5 text-(--theme-primary)" name={tab.icon} size="1rem" />
            <div>
              <h1 className="font-mono text-sm font-semibold text-foreground">{tab.label}</h1>
              <p className="mt-0.5 text-xs text-(--ui-text-tertiary)">{tab.summary}</p>
            </div>
          </div>

          {scene ? (
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
        <span aria-hidden="true" className={cn('size-1.5 rounded-full', scene ? 'bg-emerald-500' : 'bg-amber-500')} />
        <span aria-live="polite">{notice}</span>
        <span className="ml-auto">RUN owns state · UGUI projects · Desktop paints</span>
      </footer>
    </div>
  )
}
