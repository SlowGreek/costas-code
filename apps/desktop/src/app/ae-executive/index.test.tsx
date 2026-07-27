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

function batch(
  tabs: readonly string[] = AE_EXECUTIVE_BATCH_TAB_IDS,
  textByTab: Readonly<Record<string, string>> = {}
) {
  return {
    schema: 'ae-executive-scene-batch/1' as const,
    authority: 'none' as const,
    projector: 'run::tui->ugui::project;quine->ugui::project_quine_applet_route',
    scenes: tabs.map(tab => ({
      tab,
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
            layout: { height: '*' as const }
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

    for (const row of value.scenes) {expect(validateExecutiveScene(row.scene)).toEqual([])}
  })

  it('requires semantic card identity and one shared shell action row without prescribing block extent', () => {
    const value = parseExecutiveBatch(batch())

    for (const { scene, tab } of value.scenes) {
      expect(scene.id).toBe(`run-${tab}`)
      expect(
        scene.nodes.flatMap(node => Object.values(node.on ?? {})).filter(handler => handler.startsWith('shell.tab.'))
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
    expect(screen.getByRole('button', { name: tab.label }).getAttribute('aria-current')).toBe('page')
  })

  it('navigates across tabs and redraws from the cached batch', async () => {
    renderTab('home')
    expect(await screen.findByText('RUN HOME')).toBeTruthy()

    await act(async () => fireEvent.click(screen.getByRole('button', { name: '[Q]UINE' })))

    expect(await screen.findByText('RUN QUINE')).toBeTruthy()
    expect(screen.queryByText('RUN HOME')).toBeNull()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(1)
  })

  it('loads once and does not poll while a non-Logs tab remains selected', async () => {
    vi.useFakeTimers()
    renderTab('home')
    await flushPromises()

    expect(screen.getByText('RUN HOME')).toBeTruthy()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(5_000)
      await Promise.resolve()
    })

    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(1)
  })

  it('refreshes Logs on the bounded cadence and replaces the rendered rows', async () => {
    vi.useFakeTimers()
    getAeExecutiveScenes
      .mockResolvedValueOnce(batch())
      .mockResolvedValueOnce(batch(AE_EXECUTIVE_BATCH_TAB_IDS, { logs: 'RUN LOGS REFRESHED' }))

    renderTab('logs')
    await flushPromises()
    expect(screen.getByText('RUN LOGS')).toBeTruthy()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    expect(screen.getByText('RUN LOGS REFRESHED')).toBeTruthy()
    expect(screen.queryByText('RUN LOGS')).toBeNull()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(2)
  })

  it('does not overlap Logs refresh requests while the prior request is pending', async () => {
    vi.useFakeTimers()
    const pendingRefresh = deferred<ReturnType<typeof batch>>()

    getAeExecutiveScenes.mockResolvedValueOnce(batch()).mockReturnValueOnce(pendingRefresh.promise)
    renderTab('logs')
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
      pendingRefresh.resolve(batch())
      await pendingRefresh.promise
    })
  })

  it('stops Logs polling and ignores an older completion after leaving Logs', async () => {
    vi.useFakeTimers()
    const pendingRefresh = deferred<ReturnType<typeof batch>>()

    getAeExecutiveScenes.mockResolvedValueOnce(batch()).mockReturnValueOnce(pendingRefresh.promise)
    renderTab('logs')
    await flushPromises()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: '[Q]UINE' }))
    expect(screen.getByText('RUN QUINE')).toBeTruthy()

    await act(async () => {
      pendingRefresh.resolve(batch(AE_EXECUTIVE_BATCH_TAB_IDS, {
        logs: 'STALE LOGS',
        quine: 'STALE QUINE'
      }))
      await pendingRefresh.promise
      vi.advanceTimersByTime(5_000)
    })

    expect(screen.getByText('RUN QUINE')).toBeTruthy()
    expect(screen.queryByText('STALE QUINE')).toBeNull()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(2)
  })

  it('keeps the last valid Logs Scene and reports degraded freshness when refresh validation fails', async () => {
    vi.useFakeTimers()
    getAeExecutiveScenes
      .mockResolvedValueOnce(batch())
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(batch(AE_EXECUTIVE_BATCH_TAB_IDS, { logs: 'RUN LOGS RECOVERED' }))
    renderTab('logs')
    await flushPromises()

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    expect(screen.getByText('RUN LOGS')).toBeTruthy()
    expect(screen.getByText('Logs refresh degraded · showing last valid Scene')).toBeTruthy()
    expect(screen.queryByText(/UGUI Scene unavailable/)).toBeNull()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.advanceTimersByTime(1_000)
      await Promise.resolve()
    })

    expect(screen.getByText('RUN LOGS RECOVERED')).toBeTruthy()
    expect(screen.queryByText('Logs refresh degraded · showing last valid Scene')).toBeNull()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(3)
  })

  it('clears the Logs polling timer on unmount', async () => {
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
    expect(screen.getAllByRole('button', { name: '[Q]UINE' })).toHaveLength(1)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '[Q]UINE' })))
    expect(await screen.findByText('RUN QUINE')).toBeTruthy()
  })

  it('routes Marketplace-pinned applets from dynamic UGUI shell actions', async () => {
    getAeExecutiveScenes.mockResolvedValueOnce(batch(['home', 'marketplace', 'calc', 'snake']))
    const view = renderTab('marketplace')

    expect(await screen.findByText('RUN MARKETPLACE')).toBeTruthy()
    expect(view.container.querySelector('[data-ae-executive-tab="marketplace"]')).toBeTruthy()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'C[A]LCULATOR' })))
    expect(await screen.findByText('RUN CALC')).toBeTruthy()
    expect(view.container.querySelector('[data-ae-executive-tab="calc"]')).toBeTruthy()
  })

  it('realizes elastic and fixed Scene layout without tab-specific branches', async () => {
    const view = renderTab('home')
    await screen.findByText('RUN HOME')

    expect(view.container.querySelector('[data-ugui-height="*"]')?.className).toContain('flex-1')
    expect(view.container.querySelector('[data-ugui-height="1"]')?.className).toContain('shrink-0')
    expect(screen.getByText('UGUI refusal · asset-catalog-unavailable · home semantic image')).toBeTruthy()
  })

  it('does not present structural Scene admission as freshness or trust', async () => {
    const view = renderTab('home')

    expect(await screen.findByText('Rendered · structure valid · authority none · freshness unverified')).toBeTruthy()
    expect(screen.queryByText(/Scene ready/)).toBeNull()
    expect(view.container.querySelector('[data-ugui-structural-status]')?.className).not.toContain('bg-emerald-500')
  })

  it('shows an explicit unavailable state instead of synthesizing content', async () => {
    getAeExecutiveScenes.mockRejectedValueOnce(new Error('projector-unavailable'))
    renderTab('home')
    await waitFor(() => expect(screen.getByText('UGUI Scene unavailable · projector-unavailable')).toBeTruthy())
    expect(screen.queryByText('RUN HOME')).toBeNull()
  })
})
