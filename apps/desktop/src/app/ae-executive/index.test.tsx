// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AE_EXECUTIVE_BATCH_TAB_IDS, AE_EXECUTIVE_TAB_IDS, AE_EXECUTIVE_TABS, aeExecutiveTab } from './contract'
import { parseExecutiveBatch, resetExecutiveScenesForTests, validateExecutiveScene } from './scene'

import { AeExecutiveWorkspace } from '.'

const getAeExecutiveScenes = vi.fn()

const EXPECTED_LABELS = [
  '[H]OME',
  '[D]ASHBOARD',
  '[L]UCID',
  '[Q]UINE',
  'S[C]ORES',
  '[M]ETRICS',
  'L[O]GS',
  '[G]ITHUB',
  'S[T]UDIO',
  '[S]ETTINGS'
]

const dynamicLabel = (tab: string) =>
  AE_EXECUTIVE_TABS.find(item => item.id === tab)?.label ??
  ({ calc: 'C[A]LCULATOR', marketplace: 'MA[R]KETPLACE', snake: 'S[N]AKE' }[tab] ?? tab.toUpperCase())

const ARTIFACT_GENERATION = `sha256:${'a'.repeat(64)}`

const generationHash = (generation: number, salt = 0) =>
  `sha256:${((generation + salt) % 16).toString(16).repeat(64)}`

function batch(
  tabs: readonly string[] = AE_EXECUTIVE_BATCH_TAB_IDS,
  textByTab: Readonly<Record<string, string>> = {},
  generation = 1,
  freshness: 'fresh' | 'degraded' | 'stale' | 'unavailable' = 'fresh'
) {
  return {
    schema: 'ae-executive-scene-batch/2' as const,
    authority: 'none' as const,
    projector: 'run::tui->ugui::project;quine->ugui::project_quine_applet_route',
    generation,
    document_hash: generationHash(generation),
    source_set_hash: generationHash(generation, 7),
    observed_ms: 1_000 + generation,
    freshness,
    artifact_generation: ARTIFACT_GENERATION,
    scenes: tabs.map(tab => ({
      tab,
      state: 'fresh' as const,
      scene: {
        sceneVersion: '1.0.0' as const,
        id: `run-${tab}`,
        root: `${tab}-root`,
        nodes: [
          {
            id: `${tab}-root`,
            p: 'column' as const,
            kids: [`${tab}-text`, `${tab}-elastic`, `${tab}-fixed`, `${tab}-tabs`]
          },
          {
            id: `${tab}-text`,
            p: 'text' as const,
            a: { text: textByTab[tab] ?? `RUN ${tab.toUpperCase()}`, size: 'l' }
          },
          {
            id: `${tab}-elastic`,
            p: 'image' as const,
            a: { src: `asset://run/home/${tab}.svg`, alt: `${tab} semantic image` },
            layout: { height: '*' as const, width: '*' as const }
          },
          {
            id: `${tab}-fixed`,
            p: 'text' as const,
            a: { text: 'Fixed semantic status', size: 's' },
            layout: { height: 1 }
          },
          {
            id: `${tab}-tabs`,
            p: 'row' as const,
            kids: tabs.map(item => `${tab}-tab-${item}`)
          },
          ...tabs.map(item => ({
            id: `${tab}-tab-${item}`,
            p: 'button' as const,
            a: { label: dynamicLabel(item), primary: item === tab, role: 'tab' },
            on: { tap: `shell.tab.${item}` },
            layout: { height: 1 }
          }))
        ]
      }
    }))
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void

  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve()
  })
}

function renderTab(tab: string) {
  return render(
    <MemoryRouter initialEntries={[`/ae/${tab}`]}>
      <Routes>
        <Route element={<AeExecutiveWorkspace />} path="ae/:tab" />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  resetExecutiveScenesForTests()
  getAeExecutiveScenes.mockResolvedValue(batch())
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { getAeExecutiveScenes }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('AE executive registry', () => {
  it('preserves the current WITNESS seed plus GitHub, Marketplace, and SHELL recovery anchors', () => {
    expect(AE_EXECUTIVE_TAB_IDS).toHaveLength(12)
    expect(AE_EXECUTIVE_TABS.map(tab => tab.label)).toEqual([...EXPECTED_LABELS, 'MA[R]KETPLACE', 'SH[E]LL'])
    expect(AE_EXECUTIVE_TABS.map(tab => tab.mnemonic).join('')).toBe('HDLQCMOGTSRE')
    expect(AE_EXECUTIVE_TABS.map(tab => tab.route)).toEqual(AE_EXECUTIVE_TAB_IDS.map(tab => `/ae/${tab}`))
  })

  it('falls back to HOME for an unknown tab', () => {
    expect(aeExecutiveTab('not-a-tab').id).toBe('home')
  })
})

describe('Rust UGUI Scene batch', () => {
  it('admits the exact ordered batch and validates every closed Scene', () => {
    const value = parseExecutiveBatch(batch())
    expect(value.scenes).toHaveLength(AE_EXECUTIVE_BATCH_TAB_IDS.length)

    for (const row of value.scenes) {expect(validateExecutiveScene(row.scene!)).toEqual([])}
  })

  it('requires semantic card identity and one shared shell action row without prescribing block extent', () => {
    const value = parseExecutiveBatch(batch())

    for (const { scene, tab } of value.scenes) {
      expect(scene!.id).toBe(`run-${tab}`)
      expect(
        scene!.nodes.flatMap(node => Object.values(node.on ?? {})).filter(handler => handler.startsWith('shell.tab.'))
      ).toEqual(AE_EXECUTIVE_BATCH_TAB_IDS.map(id => `shell.tab.${id}`))
    }
  })

  it('admits and paints intrinsic nested Dashboard structure without remaining-height layout', async () => {
    const value = batch()
    const dashboard = value.scenes.find(row => row.tab === 'dashboard')!.scene
    const nodes = dashboard.nodes as Array<Record<string, any>>
    dashboard.nodes = nodes.filter(node => node.id !== 'dashboard-elastic') as typeof dashboard.nodes
    const root = dashboard.nodes.find(node => node.id === 'dashboard-root') as { kids: string[] }
    root.kids = root.kids.filter((id: string) => id !== 'dashboard-elastic')
    ;(dashboard.nodes as Array<Record<string, unknown>>).push(
      { id: 'dashboard-nested', p: 'column' as const, kids: ['dashboard-nested-text'] },
      { id: 'dashboard-nested-text', p: 'text' as const, a: { text: 'Nested intrinsic evidence', size: 's' } }
    )
    root.kids.splice(1, 0, 'dashboard-nested')
    getAeExecutiveScenes.mockResolvedValue(value)
    resetExecutiveScenesForTests()

    const view = renderTab('dashboard')
    expect(await screen.findByText('Nested intrinsic evidence')).toBeTruthy()
    expect(view.container.querySelector('[data-ugui-height="*"]')).toBeNull()
  })
})

describe('AE executive workspace', () => {
  it.each(AE_EXECUTIVE_TABS.filter(tab => tab.id !== 'shell'))('redraws $label from its corresponding Rust Scene', async tab => {
    const view = renderTab(tab.id)
    expect(await screen.findByText(`RUN ${tab.id.toUpperCase()}`)).toBeTruthy()
    expect(view.container.querySelector(`[data-ae-executive-tab="${tab.id}"]`)).toBeTruthy()
    expect(screen.getByRole('tab', { name: tab.label }).getAttribute('aria-current')).toBe('page')
  })

  it('navigates across tabs and redraws from the cached batch', async () => {
    renderTab('home')
    expect(await screen.findByText('RUN HOME')).toBeTruthy()

    await act(async () => fireEvent.click(screen.getByRole('tab', { name: '[Q]UINE' })))

    expect(await screen.findByText('RUN QUINE')).toBeTruthy()
    expect(screen.queryByText('RUN HOME')).toBeNull()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(1)
  })

  it('polls the whole workspace every second regardless of the selected tab', async () => {
    vi.useFakeTimers()
    renderTab('home')
    await flushPromises()

    expect(screen.getByText('RUN HOME')).toBeTruthy()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(2)
  })

  it('reconciles a newer generation while retaining the selected tab', async () => {
    vi.useFakeTimers()
    getAeExecutiveScenes
      .mockResolvedValueOnce(batch())
      .mockResolvedValueOnce(batch(AE_EXECUTIVE_BATCH_TAB_IDS, { quine: 'RUN QUINE REFRESHED' }, 2))

    renderTab('home')
    await flushPromises()
    fireEvent.click(screen.getByRole('tab', { name: '[Q]UINE' }))
    expect(screen.getByText('RUN QUINE')).toBeTruthy()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    expect(screen.getByText('RUN QUINE REFRESHED')).toBeTruthy()
    expect(screen.queryByText('RUN HOME')).toBeNull()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(2)
  })

  it('does not overlap workspace reconciliation requests', async () => {
    vi.useFakeTimers()
    const pendingRefresh = deferred<ReturnType<typeof batch>>()

    getAeExecutiveScenes.mockResolvedValueOnce(batch()).mockReturnValueOnce(pendingRefresh.promise)
    renderTab('home')
    await flushPromises()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(2)

    await act(async () => {
      pendingRefresh.resolve(batch(AE_EXECUTIVE_BATCH_TAB_IDS, {}, 2))
      await pendingRefresh.promise
    })
  })

  it('isolates a malformed unrelated tab and updates the selected valid tab', async () => {
    vi.useFakeTimers()
    const next = batch(AE_EXECUTIVE_BATCH_TAB_IDS, { home: 'RUN HOME GENERATION 2' }, 2)

    const logs = next.scenes.find(row => row.tab === 'logs')!

    ;(logs.scene.nodes[0] as { kids: string[] }).kids = ['missing-node']
    getAeExecutiveScenes.mockResolvedValueOnce(batch()).mockResolvedValueOnce(next)
    renderTab('home')
    await flushPromises()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    expect(screen.getByText('RUN HOME GENERATION 2')).toBeTruthy()
    expect(screen.getByText(/Generation 2 · authority none · observed 1002 · freshness fresh · posture live/)).toBeTruthy()
  })

  it('recovers after an initial projector failure without remounting', async () => {
    vi.useFakeTimers()
    getAeExecutiveScenes
      .mockRejectedValueOnce(new Error('projector-temporarily-unavailable'))
      .mockResolvedValueOnce(batch())
    renderTab('home')
    await flushPromises()

    expect(screen.getByText('UGUI Scene unavailable · projector-temporarily-unavailable')).toBeTruthy()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    expect(screen.getByText('RUN HOME')).toBeTruthy()
    expect(screen.queryByText(/UGUI Scene unavailable/)).toBeNull()
  })

  it('rejects an older generation and preserves the last valid selected Scene', async () => {
    vi.useFakeTimers()
    getAeExecutiveScenes
      .mockResolvedValueOnce(batch(AE_EXECUTIVE_BATCH_TAB_IDS, { home: 'GENERATION 2 HOME' }, 2))
      .mockResolvedValueOnce(batch(AE_EXECUTIVE_BATCH_TAB_IDS, { home: 'STALE GENERATION 1 HOME' }, 1))
    renderTab('home')
    await flushPromises()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    expect(screen.getByText('GENERATION 2 HOME')).toBeTruthy()
    expect(screen.queryByText('STALE GENERATION 1 HOME')).toBeNull()
  })

  it('clears the workspace polling timer on unmount', async () => {
    vi.useFakeTimers()
    const view = renderTab('logs')
    await flushPromises()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(1)

    view.unmount()
    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })

    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(1)
  })

  it('uses the UGUI shell actions as the only executive tab navigation', async () => {
    const view = renderTab('home')
    await screen.findByText('RUN HOME')

    expect(view.container.querySelector('nav[aria-label="AgentExperiments executive tabs"]')).toBeNull()
    expect(screen.getAllByRole('tab', { name: '[Q]UINE' })).toHaveLength(1)
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: '[Q]UINE' })))
    expect(await screen.findByText('RUN QUINE')).toBeTruthy()
  })

  it('routes Marketplace-pinned applets from dynamic UGUI shell actions', async () => {
    getAeExecutiveScenes.mockResolvedValueOnce(batch(['home', 'marketplace', 'calc', 'snake']))
    const view = renderTab('marketplace')

    expect(await screen.findByText('RUN MARKETPLACE')).toBeTruthy()
    expect(view.container.querySelector('[data-ae-executive-tab="marketplace"]')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('tab', { name: 'C[A]LCULATOR' })))
    expect(await screen.findByText('RUN CALC')).toBeTruthy()
    expect(view.container.querySelector('[data-ae-executive-tab="calc"]')).toBeTruthy()
  })

  it('realizes elastic and fixed Scene layout without tab-specific branches', async () => {
    const view = renderTab('home')
    await screen.findByText('RUN HOME')

    expect(view.container.querySelector('[data-ugui-height="*"]')?.className).toContain('flex-1')
    expect(view.container.querySelector('[data-ugui-width="*"]')?.className).toContain('flex-1')
    expect(view.container.querySelector('[data-ugui-height="1"]')?.className).toContain('shrink-0')
    expect(screen.getByText('UGUI refusal · asset-catalog-unavailable · home semantic image')).toBeTruthy()
  })

  it('shows exact generation, observation, freshness, posture, and artifact trust metadata', async () => {
    const view = renderTab('home')

    expect(
      await screen.findByText(
        `Generation 1 · authority none · observed 1001 · freshness fresh · posture live · artifact ${ARTIFACT_GENERATION}`
      )
    ).toBeTruthy()
    expect(view.container.querySelector('[data-ae-trust-footer]')).toBeTruthy()
    expect(view.container.querySelector('[data-ugui-structural-status]')?.className).not.toContain('bg-emerald-500')
  })

  it('shows an explicit unavailable state instead of synthesizing content', async () => {
    getAeExecutiveScenes.mockRejectedValueOnce(new Error('projector-unavailable'))
    renderTab('home')
    await waitFor(() => expect(screen.getByText('UGUI Scene unavailable · projector-unavailable')).toBeTruthy())
    expect(screen.queryByText('RUN HOME')).toBeNull()
  })
})
