// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetForTests, setWasmInputForTests } from './catalyst-wasm'
import { AE_EXECUTIVE_TAB_IDS, AE_EXECUTIVE_TABS, aeExecutiveTab } from './contract'

import { AeExecutiveWorkspace } from '.'

const getAeExecutiveDocuments = vi.fn()
const writeClipboard = vi.fn()
const ARTIFACT_GENERATION = `sha256:${'a'.repeat(64)}`

const generationHash = (generation: number, salt = 0) =>
  `sha256:${((generation + salt) % 16).toString(16).repeat(64)}`

const uguiDocument = (tab: string, body = `RUN ${tab.toUpperCase()}`) => ({
  id: `run-${tab}`,
  type: 'document',
  header: [{ id: `${tab}-heading`, type: 'text', body, style: 'heading' }],
  sections: [
    { id: `${tab}-status`, type: 'status_grid', items: [{ label: 'State', value: 'Ready', status: 'ok' }] }
  ],
  actions: AE_EXECUTIVE_TAB_IDS.map(item => ({
    id: `${tab}-tab-${item}`,
    type: 'button',
    label: AE_EXECUTIVE_TABS.find(candidate => candidate.id === item)!.label,
    action: `shell.tab.${item}`,
    role: 'tab',
    primary: item === tab
  }))
})

function envelope(generation = 1, textByTab: Readonly<Record<string, string>> = {}) {
  return {
    schema: 'ae-executive-document-envelope/1' as const,
    authority: 'RUN_EXECUTIVE_COMPOSER' as const,
    executive_generation: generation,
    document_hash: generationHash(generation),
    source_set_hash: generationHash(generation, 7),
    observed_ms: 1_000 + generation,
    freshness: 'fresh' as const,
    artifact_posture: 'observed' as const,
    admission_code: 'admitted',
    blocker: null,
    artifact_generation: ARTIFACT_GENERATION,
    rows: AE_EXECUTIVE_TAB_IDS.map((tab, index) => ({
      schema: 'ae-executive-document-row/1' as const,
      tab,
      source_hash: generationHash(generation, index + 1),
      source_generation: generation,
      observed_ms: 1_000 + generation,
      freshness: 'fresh' as const,
      posture: 'observed' as const,
      artifact_posture: 'observed' as const,
      document: uguiDocument(tab, textByTab[tab]),
      code: null
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

beforeAll(() => {
  // The real engine paints these tests; nothing about UGUI is mocked.
  setWasmInputForTests(readFileSync(resolve(process.cwd(), 'public/wasm/catalyst_wasm_bg.wasm')))
})

beforeEach(() => {
  resetForTests()
  getAeExecutiveDocuments.mockResolvedValue(envelope())
  writeClipboard.mockResolvedValue(undefined)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      getAeExecutiveDocuments,
      executeLucidExecutiveIntent: vi.fn(),
      submitStudioDesignerEvent: vi.fn(),
      writeClipboard
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('AE executive Document registry', () => {
  it('matches the producer-owned 13-tab order and mnemonics', () => {
    expect(AE_EXECUTIVE_TAB_IDS).toHaveLength(13)
    expect(AE_EXECUTIVE_TABS.map(tab => tab.mnemonic).join('')).toBe('HDLQCMOGTSREA')
    expect(AE_EXECUTIVE_TABS.map(tab => tab.route)).toEqual(AE_EXECUTIVE_TAB_IDS.map(tab => `/ae/${tab}`))
    expect(AE_EXECUTIVE_TABS.at(-1)?.label).toBe('MERM[A]ID')
  })

  it('falls back to HOME for an unknown tab', () => {
    expect(aeExecutiveTab('not-a-tab').id).toBe('home')
  })
})

describe('AE executive Document workspace', () => {
  it('paints the selected Document with the shared engine, not React', async () => {
    renderTab('home')

    await waitFor(() => expect(screen.getByText('RUN HOME')).not.toBeNull())
    const surface = window.document.querySelector('[data-ugui-surface]')

    expect(surface?.getAttribute('data-ugui-painter')).toBe('rust-wasm')
    expect(surface?.querySelector('[data-ugui-action="shell.tab.dashboard"]')).not.toBeNull()
  })

  it('routes a painted shell tab action through the engine', async () => {
    renderTab('home')
    await waitFor(() => expect(screen.getByText('RUN HOME')).not.toBeNull())

    fireEvent.click(
      window.document.querySelector('[data-ugui-action="shell.tab.dashboard"]') as Element
    )
    await waitFor(() => expect(screen.getByText('RUN DASHBOARD')).not.toBeNull())
  })

  it('reconciles a newer generation and refuses an older one', async () => {
    vi.useFakeTimers()
    getAeExecutiveDocuments
      .mockResolvedValueOnce(envelope(2, { home: 'Generation two' }))
      .mockResolvedValueOnce(envelope(3, { home: 'Generation three' }))
      .mockResolvedValueOnce(envelope(1, { home: 'Generation one' }))
    renderTab('home')

    await act(async () => {await vi.advanceTimersByTimeAsync(0)})
    expect(screen.getByText('Generation two')).not.toBeNull()

    await act(async () => {await vi.advanceTimersByTimeAsync(1_000)})
    expect(screen.getByText('Generation three')).not.toBeNull()

    await act(async () => {await vi.advanceTimersByTimeAsync(1_000)})
    expect(screen.queryByText('Generation one')).toBeNull()
    expect(screen.getByText(/out-of-order-generation/)).not.toBeNull()
  })

  it('preserves the last valid Document when a newer row becomes unavailable', async () => {
    vi.useFakeTimers()
    const next = envelope(2)
    const home = next.rows[0] as Record<string, unknown>

    home.document = null
    home.freshness = 'unavailable'
    home.posture = 'unavailable'
    home.artifact_posture = 'unavailable'
    home.code = 'home-unavailable'
    getAeExecutiveDocuments.mockResolvedValueOnce(envelope(1)).mockResolvedValueOnce(next)
    renderTab('home')

    await act(async () => {await vi.advanceTimersByTimeAsync(0)})
    await act(async () => {await vi.advanceTimersByTimeAsync(1_000)})

    expect(screen.getByText('RUN HOME')).not.toBeNull()
    expect(screen.getAllByText(/last valid Document preserved/).length).toBeGreaterThan(0)
  })

  it('shows a bounded Document refusal when no generation is available', async () => {
    getAeExecutiveDocuments.mockRejectedValue(new Error('projector-unavailable'))
    renderTab('home')

    await waitFor(() =>
      expect(screen.getByText('UGUI Document unavailable · projector-unavailable')).not.toBeNull()
    )
    expect(screen.queryByText('RUN HOME')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Copy error' }))
    await waitFor(() =>
      expect(writeClipboard).toHaveBeenCalledWith('UGUI Document unavailable · projector-unavailable')
    )
  })
})
