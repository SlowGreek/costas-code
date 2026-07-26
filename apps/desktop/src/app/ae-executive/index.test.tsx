// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AE_EXECUTIVE_TAB_IDS, AE_EXECUTIVE_TABS, aeExecutiveTab } from './contract'
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
  'S[T]UDIO',
  '[S]ETTINGS'
]

function batch() {
  return {
    schema: 'ae-executive-scene-batch/1' as const,
    authority: 'none' as const,
    projector: 'ugui::executive->ugui::project',
    scenes: AE_EXECUTIVE_TAB_IDS.map(tab => ({
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
          { id: `${tab}-text`, p: 'text' as const, a: { text: `RUN ${tab.toUpperCase()}`, size: 'l' } },
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
            kids: AE_EXECUTIVE_TABS.map(item => `${tab}-tab-${item.id}`)
          },
          ...AE_EXECUTIVE_TABS.map(item => ({
            id: `${tab}-tab-${item.id}`,
            p: 'button' as const,
            a: { label: item.label, primary: item.id === tab, role: 'tab' },
            on: { tap: `shell.tab.${item.id}` },
            layout: { height: 1 }
          }))
        ]
      }
    }))
  }
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
  vi.clearAllMocks()
})

describe('AE executive registry', () => {
  it('preserves the exact RUN tab order, mnemonics, and nine distinct routes', () => {
    expect(AE_EXECUTIVE_TAB_IDS).toHaveLength(9)
    expect(AE_EXECUTIVE_TABS.map(tab => tab.label)).toEqual(EXPECTED_LABELS)
    expect(AE_EXECUTIVE_TABS.map(tab => tab.mnemonic).join('')).toBe('HDLQCMOTS')
    expect(AE_EXECUTIVE_TABS.map(tab => tab.route)).toEqual(AE_EXECUTIVE_TAB_IDS.map(tab => `/ae/${tab}`))
  })

  it('falls back to HOME for an unknown tab', () => {
    expect(aeExecutiveTab('not-a-tab').id).toBe('home')
  })
})

describe('Rust UGUI Scene batch', () => {
  it('admits the exact ordered batch and validates every closed Scene', () => {
    const value = parseExecutiveBatch(batch())
    expect(value.scenes).toHaveLength(9)

    for (const row of value.scenes) {expect(validateExecutiveScene(row.scene)).toEqual([])}
  })

  it('requires semantic card identity, layout intent, and one shared shell action row', () => {
    const value = parseExecutiveBatch(batch())

    for (const { scene, tab } of value.scenes) {
      expect(scene.id).toBe(`run-${tab}`)
      expect(scene.nodes.some(node => node.layout?.height === '*')).toBe(true)
      expect(
        scene.nodes.flatMap(node => Object.values(node.on ?? {})).filter(handler => handler.startsWith('shell.tab.'))
      ).toEqual(AE_EXECUTIVE_TAB_IDS.map(id => `shell.tab.${id}`))
    }
  })
})

describe('AE executive workspace', () => {
  it.each(AE_EXECUTIVE_TABS)('redraws $label from its corresponding Rust Scene', async tab => {
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

  it('uses the UGUI shell actions as the only executive tab navigation', async () => {
    const view = renderTab('home')
    await screen.findByText('RUN HOME')

    expect(view.container.querySelector('nav[aria-label="AgentExperiments executive tabs"]')).toBeNull()
    expect(screen.getAllByRole('button', { name: '[Q]UINE' })).toHaveLength(1)
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '[Q]UINE' })))
    expect(await screen.findByText('RUN QUINE')).toBeTruthy()
  })

  it('realizes elastic and fixed Scene layout without tab-specific branches', async () => {
    const view = renderTab('home')
    await screen.findByText('RUN HOME')

    expect(view.container.querySelector('[data-ugui-height="*"]')?.className).toContain('flex-1')
    expect(view.container.querySelector('[data-ugui-height="1"]')?.className).toContain('shrink-0')
    expect(screen.getByText('UGUI refusal · asset-catalog-unavailable · home semantic image')).toBeTruthy()
  })

  it('shows an explicit unavailable state instead of synthesizing content', async () => {
    getAeExecutiveScenes.mockRejectedValueOnce(new Error('projector-unavailable'))
    renderTab('home')
    await waitFor(() => expect(screen.getByText('UGUI Scene unavailable · projector-unavailable')).toBeTruthy())
    expect(screen.queryByText('RUN HOME')).toBeNull()
  })
})
