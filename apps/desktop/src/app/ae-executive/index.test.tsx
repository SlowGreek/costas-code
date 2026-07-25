// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'

import { AE_EXECUTIVE_TAB_IDS, AE_EXECUTIVE_TABS, aeExecutiveTab } from './contract'
import { executiveScene } from './scene'
import { validateExecutiveScene } from './scene-painter'

import { AeExecutiveWorkspace } from '.'

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

function renderTab(tab: string) {
  return render(
    <MemoryRouter initialEntries={[`/ae/${tab}`]}>
      <Routes>
        <Route element={<AeExecutiveWorkspace />} path="ae/:tab" />
      </Routes>
    </MemoryRouter>
  )
}

afterEach(cleanup)

describe('AE executive registry', () => {
  it('preserves the exact RUN tab order, mnemonics, and nine distinct routes', () => {
    expect(AE_EXECUTIVE_TAB_IDS).toHaveLength(9)
    expect(AE_EXECUTIVE_TABS.map(tab => tab.label)).toEqual(EXPECTED_LABELS)
    expect(AE_EXECUTIVE_TABS.map(tab => tab.mnemonic).join('')).toBe('HDLQCMOTS')
    expect(AE_EXECUTIVE_TABS.map(tab => tab.route)).toEqual(AE_EXECUTIVE_TAB_IDS.map(tab => `/ae/${tab}`))
    expect(new Set(AE_EXECUTIVE_TABS.map(tab => tab.route)).size).toBe(9)
  })

  it('falls back to HOME for an unknown tab without changing the closed registry', () => {
    expect(aeExecutiveTab('not-a-tab').id).toBe('home')
  })
})

describe('AE executive Scenes', () => {
  it.each(AE_EXECUTIVE_TAB_IDS)('produces one valid deterministic %s Scene', tab => {
    const first = executiveScene(tab)
    const second = executiveScene(tab)

    expect(validateExecutiveScene(first)).toEqual([])
    expect(first).toEqual(second)
    expect(first.tab).toBe(tab)
    expect(first.root).toBe(`ae-${tab}-root`)
    expect(first.nodes.length).toBeGreaterThan(4)
  })
})

describe('AE executive workspace', () => {
  it.each(AE_EXECUTIVE_TABS)('renders $label as a real Desktop destination', tab => {
    const view = renderTab(tab.id)

    expect(screen.getByRole('navigation', { name: 'AgentExperiments executive tabs' })).toBeTruthy()
    expect(screen.getByLabelText(`AE ${tab.id} Scene`)).toBeTruthy()
    expect(view.container.querySelector(`[data-ae-executive-tab="${tab.id}"]`)).toBeTruthy()
    expect(screen.getByRole('button', { name: tab.label }).getAttribute('aria-current')).toBe('page')
  })

  it('navigates across tabs without remapping the mnemonic labels', () => {
    renderTab('home')

    fireEvent.click(screen.getByRole('button', { name: '[Q]UINE' }))

    expect(screen.getByLabelText('AE quine Scene')).toBeTruthy()
    expect(screen.getByRole('button', { name: '[Q]UINE' }).getAttribute('aria-current')).toBe('page')
  })

  it('captures a typed Scene intent without claiming an effect', () => {
    renderTab('studio')

    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))

    expect(screen.getByText('Intent captured · studio:validate · no effect without Butler receipt')).toBeTruthy()
  })
})
