import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { CopyButton } from '@/components/ui/copy-button'
import { cn } from '@/lib/utils'

import {
  type CatalystBatch,
  type CatalystEffect,
  type CatalystTab,
  dispatchEvent,
  documentAction,
  globalKey,
  init,
  loadTabs,
  mountDocument,
  observe,
  onEffect,
  openDocumentSource,
  paintCatalogTab,
  preferenceSelection,
  preferenceVocabulary,
  projectsInput,
  selectTab,
  skinField,
  UGUI_GESTURES,
  uguiActionFromEvent,
  type UguiHit
} from './catalyst-wasm'
import {
  loadRenderProfileCatalog,
  previewRenderProfile,
  revertRenderProfilePreview
} from '@/store/render-profile'
import { useTheme } from '@/themes/context'

import { AE_EXECUTIVE_TAB_IDS, aeExecutiveTab } from './contract'

const EXECUTIVE_RECONCILE_INTERVAL_MS = 1_000

function DocumentUnavailable({ reason, tone }: { reason: string; tone: 'destructive' | 'warning' }) {
  const diagnostic = `UGUI Document unavailable · ${reason}`

  return (
    <section
      className={cn(
        'relative rounded-xl border p-5 pr-14 font-mono text-sm',
        tone === 'destructive'
          ? 'border-destructive/50 bg-destructive/5 text-destructive'
          : 'border-amber-500/50 bg-amber-500/5 text-amber-700'
      )}
      data-selectable-text="true"
    >
      <span className="break-words">{diagnostic}</span>
      <CopyButton
        appearance="icon"
        buttonSize="icon-sm"
        className="absolute right-3 top-3 text-current hover:bg-current/10 hover:text-current"
        iconClassName="size-4"
        label="Copy error"
        side="left"
        text={diagnostic}
      />
    </section>
  )
}

export function AeExecutiveWorkspace() {
  const navigate = useNavigate()
  const params = useParams<{ tab?: string }>()
  const [batch, setBatch] = useState<CatalystBatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('Loading UGUI projection…')
  const [seated, setSeated] = useState(false)
  const [authoredTabs, setAuthoredTabs] = useState<readonly CatalystTab[]>([])
  const [overlay, setOverlay] = useState<string | null>(null)
  const [documentNotice, setDocumentNotice] = useState<string | null>(null)
  const overlaySurface = useRef<HTMLDivElement | null>(null)
  const surface = useRef<HTMLDivElement | null>(null)
  const admitted = useRef(false)
  const activeSkin = useRef('')
  const activePreferences = useRef<Record<string, string>>({})
  const { setMode } = useTheme()

  const requestedTab = params.tab ?? ''
  const authored = authoredTabs.find(tab => tab.id === requestedTab)

  const tabId = authored || AE_EXECUTIVE_TAB_IDS.includes(requestedTab as never)
    ? requestedTab
    : aeExecutiveTab(requestedTab).id

  const catalogTab = authoredTabs.find(tab => tab.id === tabId && !tab.batch)

  useEffect(() => {
    let active = true

    admitted.current = false

    if (surface.current) {
      const element = surface.current

      void loadTabs()
        .then(tabs => {
          if (active) {setAuthoredTabs(tabs)}

          return init(element, tabs.filter(tab => tab.batch).map(tab => tab.id))
        })
        .then(
        () => {
          if (active) {setSeated(true)}
        },
        (reason: unknown) => {
          if (active) {setNotice(`Engine unavailable · ${String(reason)}`)}
        }
      )
    }

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!seated) {return}
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null

    onEffect((effect: CatalystEffect) => {
      if (effect.kind === 'tab.select' && effect.tab) {navigate(`/ae/${effect.tab}`)}

      if (effect.kind === 'refused') {
        setNotice(`Intent refused · ${effect.code} · ${effect.detail ?? ''}`)
      }
    })

    const reconcile = async () => {
      if (!active) {return}

      try {
        const receipt = await observe()

        if (!active) {return}
        admitted.current = Boolean(receipt.batch)
        setBatch(receipt.batch ?? null)
        setError(null)
        setNotice(
          receipt.accepted
            ? `Generation ${displayGeneration(receipt.batch)} ${receipt.reason === 'duplicate' ? 'unchanged · exact duplicate' : 'admitted'}`
            : `Reconciliation refused · ${receipt.reason} · showing generation ${displayGeneration(receipt.batch)}`
        )
      } catch (reason) {
        if (!active) {return}
        const message = reason instanceof Error ? reason.message : 'ae-executive-projector-unavailable'

        if (admitted.current) {
          setNotice(`Reconciliation degraded · ${message} · showing last valid rows`)
        } else {
          setError(message)
          setNotice('Document unavailable · reconciliation will retry')
        }
      } finally {
        if (active) {timer = setTimeout(reconcile, EXECUTIVE_RECONCILE_INTERVAL_MS)}
      }
    }

    void reconcile()

    return () => {
      active = false
      onEffect(null)

      if (timer !== null) {clearTimeout(timer)}
    }
  }, [navigate, seated])

  useEffect(() => {
    if (!seated) {return}

    if (catalogTab) {
      void paintCatalogTab(catalogTab.id)
        .then(() => {
          setNotice(`${catalogTab.label} · painted from the ${catalogTab.source} catalog`)
          paintSelection.current()
        })
        .catch((reason: unknown) => setNotice(`Tab refused · ${String(reason)}`))

      return
    }

    void selectTab(tabId).catch(() => setNotice(`Tab refused · ${tabId}`))
  }, [catalogTab, seated, tabId])

  useEffect(() => {
    if (!overlay || !overlaySurface.current) {return}

    // A fresh paint carries no selection, so the committed choice is restated
    // onto it — otherwise every control looks unselected on first open.
    void openDocumentSource(overlaySurface.current, overlay)
      .then(() => paintSelection.current())
      .catch((reason: unknown) => setNotice(`Document refused · ${String(reason)}`))
  }, [overlay])

  // The engine says what a Document action means; this host only carries it out.
  function routeDocument(hit: UguiHit) {
    const resolved = documentAction(hit.action, hit.itemId, hit.value)

    switch (resolved.kind) {
      case 'open-document':
        setOverlay(resolved.source ?? null)

        break

      case 'external':
        if (resolved.url) {window.open(resolved.url, '_blank', 'noopener,noreferrer')}

        break
      case 'skin': {
        // Appearance settings and this applet are two doors onto one skin state.
        const skinId = typeof resolved.value === 'string' ? resolved.value : ''

        if (resolved.operation === 'reset') {
          setDocumentNotice(revertRenderProfilePreview() ? 'skin · reverted' : 'skin refused')

          break
        }
        if (resolved.operation === 'field') {
          // The engine generates Skin Studio, so it owns which field an edit may
          // address and what the edit repaints.
          const variables = skinField(activeSkin.current, resolved.nodeId ?? hit.itemId, resolved.value)

          if (variables) {
            for (const [name, value] of Object.entries(variables)) {
              document.documentElement.style.setProperty(name, value)
            }
          }
          setDocumentNotice(
            variables ? `skin field · ${resolved.nodeId ?? hit.itemId}` : `skin field refused · ${hit.itemId}`
          )

          break
        }
        activeSkin.current = skinId
        void applySkin(skinId)

        break
      }

      case 'preference': {
        setDocumentNotice(
          applyPreference(resolved.preference ?? '', String(resolved.value ?? ''))
        )

        break
      }

      case 'refused':
        setDocumentNotice(`Action refused · ${resolved.code ?? ''} ${resolved.detail ?? ''}`)

        break
      case 'handler': {
        const frame = projectsInput(resolved.handler ?? hit.action, resolved.nodeId ?? '', resolved.value)

        if (frame.document && surface.current) {
          void mountDocument(surface.current, frame.document)
          setDocumentNotice(`${resolved.handler ?? hit.action} · applied`)
        } else {
          setDocumentNotice(`${resolved.handler ?? hit.action} · ${frame.error ?? frame.detail ?? 'unseated'}`)
        }

        break
      }

      default:
        setDocumentNotice(`${resolved.kind} · ${hit.action}`)
    }
  }

  // The engine resolves which preference and which choice, and admits the choice
  // against its own vocabulary; this host owns only where it is carried out.
  function applyPreference(preference: string, choice: string): string {
    if (!choice) {return `${preference} refused · no choice`}

    switch (preference) {
      case 'theme':
        setMode(choice === 'dark' ? 'dark' : 'light')

        break
      case 'background':
        document.documentElement.dataset.uguiBackground = choice

        break
      default:
        // `surface` and `vertical` reshape the Document rather than the shell,
        // and no applet handler answers them yet.
        return `${preference} · ${choice} · not yet projected`
    }
    activePreferences.current = { ...activePreferences.current, [preference]: choice }
    paintPreferenceSelection()

    return `${preference} · ${choice}`
  }

  // A control group has to show which choice is committed, or every door looks
  // inert even when it worked. The engine names both the actions that form a
  // group and the node each committed choice selects.
  function paintPreferenceSelection() {
    const selected = preferenceSelection(activePreferences.current)
    const committed = new Set(Object.values(selected))
    const grouped = new Set(
      Object.values(preferenceVocabulary())
        .map(preference => preference.action)
        .filter((action): action is string => Boolean(action))
    )

    for (const root of [surface.current, overlaySurface.current]) {
      for (const control of root?.querySelectorAll('[data-ugui-action]') ?? []) {
        if (!grouped.has(control.getAttribute('data-ugui-action') ?? '')) {continue}

        const active = committed.has(control.getAttribute('data-ugui-id') ?? '')

        control.setAttribute('aria-pressed', String(active))
        control.toggleAttribute('data-selected', active)
      }
    }
  }

  // A repaint replaces the DOM these attributes live on, so the painter is held
  // in a ref that mount effects can call after the engine has finished.
  const paintSelection = useRef(paintPreferenceSelection)

  paintSelection.current = paintPreferenceSelection

  // This door may be the first one opened, so it seats the catalog the way the
  // Appearance settings door does rather than refusing an unseated skin.
  async function applySkin(skinId: string) {
    if (previewRenderProfile(skinId)) {
      setDocumentNotice(`skin · ${skinId}`)

      return
    }
    await loadRenderProfileCatalog().catch(() => undefined)
    setDocumentNotice(
      previewRenderProfile(skinId) ? `skin · ${skinId}` : `skin refused · ${skinId}`
    )
  }

  function routeOverlayGesture(target: EventTarget | null, gesture: string) {
    const hit = uguiActionFromEvent(target, gesture)

    if (hit) {routeDocument(hit)}
  }

  function routeGesture(target: EventTarget | null, gesture: string) {
    const hit = uguiActionFromEvent(target, gesture)

    if (!hit) {return}

    // A catalog Document speaks the engine's web vocabulary; only a
    // RUN tab speaks the executive intent set.
    if (catalogTab) {
      routeDocument(hit)

      return
    }

    void dispatchEvent({
      schema: 'ugui-document-event/1',
      document_id: tabId,
      item_id: hit.itemId,
      gesture: gesture === 'click' ? 'tap' : gesture,
      action: hit.action,
      payload: hit.value ?? null
    })
  }

  // The engine paints these surfaces, so they are listened to natively: React
  // only tracks value changes on elements it rendered itself.
  const routers = useRef({ routeGesture, routeOverlayGesture })

  routers.current = { routeGesture, routeOverlayGesture }

  useEffect(() => {
    const bind = (element: HTMLElement | null, route: 'routeGesture' | 'routeOverlayGesture') =>
      UGUI_GESTURES.flatMap(gesture => {
        if (!element) {return []}

        const listener = (event: Event) => routers.current[route](event.target, gesture)

        element.addEventListener(gesture, listener)

        return [() => element.removeEventListener(gesture, listener)]
      })

    const release = [
      ...bind(surface.current, 'routeGesture'),
      ...bind(overlaySurface.current, 'routeOverlayGesture')
    ]

    return () => release.forEach(off => off())
  }, [overlay])

  // A keystroke is a gesture too, and the engine already decides what each one
  // means; this host only listens and carries the decision out.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const editing = (event.target as HTMLElement | null)?.closest?.('input, textarea, select')

      if (editing) {return}

      // Dismissing this overlay is host chrome, not Document semantics: the
      // engine's key vocabulary has no say over a div this host owns.
      if (event.key === 'Escape' && overlay) {
        setOverlay(null)
        event.preventDefault()

        return
      }

      const decision = globalKey(event.key, {
        meta: event.metaKey,
        control: event.ctrlKey,
        alt: event.altKey
      })

      switch (decision.kind) {
        case 'focus-search':
          surface.current?.querySelector<HTMLInputElement>('input[type="search"], input')?.focus()
          event.preventDefault()

          break
        case 'system-app':
          setDocumentNotice(`system-app · ${String(decision.value ?? '')}`)

          break
        default:
          break
      }
    }

    window.addEventListener('keydown', listener)

    return () => window.removeEventListener('keydown', listener)
  }, [overlay])

  const selectedRow = batch?.rows.find(row => row.tab === tabId)
  const painted = Boolean(catalogTab) || Boolean(selectedRow?.hasDocument)

  const trust = batch
    ? `Generation ${displayGeneration(batch)} · authority ${batch.authority} · observed ${batch.observedMs ?? 'unverified'} · freshness ${batch.freshness} · posture ${batch.posture} · artifact ${batch.artifactGeneration}`
    : notice

  const selectedStatus = selectedRow
    ? `${selectedRow.tab} ${selectedRow.state}${selectedRow.preserved ? ' · last valid Document preserved' : ''}${selectedRow.code ? ` · ${selectedRow.code}` : ''}`
    : null

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background"
      data-ae-executive-tab={tabId}
    >
      <main className="min-h-0 flex-1 overflow-hidden p-3">
        <div className="mx-auto h-full min-h-0 w-full max-w-7xl">
          <div className={cn('flex h-full min-h-0 flex-col gap-2', painted ? '' : 'hidden')}>
            {selectedRow && selectedRow.state !== 'fresh' ? (
              <div
                aria-live="polite"
                className="shrink-0 rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2 font-mono text-xs text-amber-700"
                data-ae-document-posture={selectedRow.state}
                role="status"
              >
                UGUI Document {selectedRow.state} · {selectedRow.code ?? 'producer posture'}
                {selectedRow.preserved ? ' · last valid Document preserved' : ''}
              </div>
            ) : null}
            {/* The engine paints into this region; React never walks the Document. */}
            <div className="min-h-0 flex-1" data-ugui-surface ref={surface} />
          </div>
          {painted ? null : error ? (
            <DocumentUnavailable reason={error} tone="destructive" />
          ) : selectedRow ? (
            <DocumentUnavailable reason={selectedRow.code ?? selectedRow.state} tone="warning" />
          ) : (
            <section className="rounded-xl border border-(--ui-stroke-tertiary) p-5 font-mono text-sm text-(--ui-text-tertiary)">
              Projecting UGUI…
            </section>
          )}
        </div>
      </main>

      {overlay ? (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-8"
          onClick={event => {
            if (event.target === event.currentTarget) {setOverlay(null)}
          }}
          role="presentation"
        >
          <div
            aria-label={overlay}
            aria-modal="true"
            className="max-h-full w-full max-w-3xl overflow-auto rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-bg-primary) p-6"
            data-ae-l2-overlay={overlay}
            role="dialog"
          >
            {/* The engine paints the L2 Document; React never walks it either. */}
            <div data-ugui-surface ref={overlaySurface} />
          </div>
        </div>
      ) : null}

      <footer className="flex h-7 shrink-0 items-center gap-2 border-t border-(--ui-stroke-tertiary) px-4 text-[0.65rem] text-(--ui-text-quaternary)">
        <span
          aria-hidden="true"
          className={cn('size-1.5 rounded-full', painted ? 'bg-sky-500' : 'bg-amber-500')}
          data-ugui-structural-status
        />
        <span aria-live="polite" data-ae-trust-footer>{trust}</span>
        <span className="truncate" data-ae-document-action>
          {documentNotice ? `${documentNotice} · ` : ''}
        </span>
        <span className="truncate" data-ae-reconcile-notice>
          · {notice}
        </span>
        {selectedStatus && <span className="truncate">· {selectedStatus}</span>}
        <span className="ml-auto shrink-0">UGUI documents · UGUI composition/layout · UGUI paint</span>
      </footer>
    </div>
  )
}

function displayGeneration(batch: CatalystBatch | null | undefined): string {
  return batch?.generation == null ? 'unavailable' : String(batch.generation)
}
