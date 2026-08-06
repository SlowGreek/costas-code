import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import settings from '../../../../../../projects/apps/settings.json'
import skins from '../../../../../../projects/apps/skins.json'

import { resetForTests, setWasmInputForTests } from './catalyst-wasm'
import {
  AE_EXECUTIVE_BATCH_TAB_IDS,
  AE_EXECUTIVE_TAB_IDS,
  AE_EXECUTIVE_TABS,
  aeExecutiveTab
} from './contract'

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
  actions: AE_EXECUTIVE_BATCH_TAB_IDS.map(item => ({
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
    rows: AE_EXECUTIVE_BATCH_TAB_IDS.map((tab, index) => ({
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
  it('matches the authored tab order and mnemonics, catalog tabs included', () => {
    // 13 batch tabs carry envelope rows; MICROSOFT is painted from the projects catalog.
    expect(AE_EXECUTIVE_TAB_IDS).toHaveLength(14)
    expect(AE_EXECUTIVE_BATCH_TAB_IDS).toHaveLength(13)
    expect(AE_EXECUTIVE_BATCH_TAB_IDS).not.toContain('microsoft')
    expect(AE_EXECUTIVE_TABS.map(tab => tab.mnemonic).join('')).toBe('HDLQCMOGTSREAF')
    expect(AE_EXECUTIVE_TABS.map(tab => tab.route)).toEqual(AE_EXECUTIVE_TAB_IDS.map(tab => `/ae/${tab}`))
    expect(AE_EXECUTIVE_TABS.at(-1)?.label).toBe('MICROS[F]T')
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

describe('authored catalog tabs', () => {
  it('paints the MICROSOFT keystone from the projects catalog, not the RUN envelope', async () => {
    renderTab('microsoft')

    // The envelope carries no row for a catalog tab; the engine paints it anyway.
    await waitFor(() => {
      const surface = window.document.querySelector('[data-ugui-surface]')

      expect(surface?.getAttribute('data-ugui-painter')).toBe('rust-wasm')
    })
    const surface = window.document.querySelector('[data-ugui-surface]') as Element

    expect(surface.querySelector('img')).not.toBeNull()
    expect(surface.querySelector('select')).not.toBeNull()
    expect(surface.querySelector('input')).not.toBeNull()
    // No envelope row backs this tab, so nothing reports it unavailable.
    expect(screen.queryByText(/UGUI Document unavailable/)).toBeNull()
  })
})

describe('authored L2 documents', () => {
  it('opens a nested-card source as an overlay the engine paints', async () => {
    // The engine carries the authored Document, so opening one must not reach
    // the network or a staged copy of the projects folder.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no fetch') }))
    renderTab('microsoft')
    await waitFor(() => {
      expect(
        window.document.querySelector('[data-ugui-action="projects.source.open"]')
      ).not.toBeNull()
    })

    const trigger = window.document.querySelector('[data-ugui-action="projects.source.open"]')

    expect(trigger).not.toBeNull()
    fireEvent.click(trigger as Element)

    // The overlay is a second painted surface, not React-rendered Document markup.
    await waitFor(() => {
      expect(window.document.querySelector('[data-ae-l2-overlay]')).not.toBeNull()
    })
    expect(global.fetch).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(window.document.querySelector('[data-ae-l2-overlay]')?.textContent).toContain(
        'Settings'
      )
    })
  })

  it('routes an L2 button through the engine instead of swallowing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => settings }) as unknown as Response)
    )
    renderTab('microsoft')
    await waitFor(() => {
      expect(
        window.document.querySelector('[data-ugui-action="projects.source.open"]')
      ).not.toBeNull()
    })
    fireEvent.click(
      window.document.querySelector('[data-ugui-action="projects.source.open"]') as Element
    )
    await waitFor(() => {
      expect(window.document.querySelector('[data-ae-l2-overlay]')).not.toBeNull()
    })

    const overlay = window.document.querySelector('[data-ae-l2-overlay]') as Element
    const button = overlay.querySelector('[data-ugui-action^="projects."]') as Element

    // A Document action is answered by the engine's web vocabulary, never by the
    // RUN intent set this host uses for executive tabs. The first authored
    // control is the Light/Dark pair, whose choice lives in the node id rather
    // than in a value — a button carries none.
    expect(button).not.toBeNull()
    fireEvent.click(button)

    const choice = (button.getAttribute('data-ugui-id') ?? '').replace('projects.theme.', '')

    await waitFor(() => {
      const notice = window.document.querySelector('[data-ae-document-action]')?.textContent ?? ''

      expect(notice).toContain(`theme · ${choice}`)
    })
  })
})

const stubProfile = (id: string) => ({
  id,
  label: id,
  axes: {
    palette: {
      surface: '#ece9d8',
      on_surface: '#222222',
      accent: '#0055e5',
      border: '#003c74',
      translucency: 0
    },
    typography: { family_stack: 'Tahoma', scale_px: [11], weights: [400], casing: 'none' },
    geometry: { radius_px: [0, 3, 8], stroke_width_px: 1, grid_unit_px: 4 },
    border: { model: 'bevel', raw: {} },
    elevation: { blur_px: 0, backdrop_blur_px: 0, spread_px: 0, y_offset_px: 1 },
    density: { spacing_px: [4, 8] },
    motion: { mode: 'instant', durations_ms: [0], easing: 'linear' },
    chrome: { frame: 'beveled' }
  }
})

describe('one skin state, two doors', () => {
  it('drives the same store Appearance settings drives', async () => {
    const { $renderProfileCatalog, $renderProfilePreviewId } = await import(
      '@/store/render-profile'
    )

    $renderProfileCatalog.set({
      schema: 'ugui-skin-catalog/1',
      profiles: [stubProfile('winxp'), stubProfile('terminal')]
    } as never)
    $renderProfilePreviewId.set(null)

    const { previewRenderProfile } = await import('@/store/render-profile')

    // The applet's skin action is this call; Appearance settings makes the same one.
    expect(previewRenderProfile('winxp')).toBe(true)
    expect($renderProfilePreviewId.get()).toBe('winxp')
    expect(previewRenderProfile('not-a-skin')).toBe(false)
    expect($renderProfilePreviewId.get()).toBe('winxp')
  })

  it('applies the skin the dropdown selects, not the one a click guesses', async () => {
    const { $renderProfileCatalog, $renderProfilePreviewId } = await import(
      '@/store/render-profile'
    )

    $renderProfileCatalog.set({
      schema: 'ugui-skin-catalog/1',
      profiles: [stubProfile('winxp'), stubProfile('terminal')]
    } as never)
    $renderProfilePreviewId.set(null)
    renderTab('microsoft')
    await waitFor(() => {
      expect(
        window.document.querySelector('[data-ugui-action="projects.source.open"]')
      ).not.toBeNull()
    })
    fireEvent.click(
      window.document.querySelector('[data-ugui-action="projects.source.open"]') as Element
    )

    // Settings opens first; Designer is the door onto Skin Studio inside it.
    const designer = await waitFor(() => {
      const found = window.document.querySelector(
        '[data-ae-l2-overlay] [data-ugui-source="/apps/skins.json"]'
      )

      expect(found).not.toBeNull()

      return found as Element
    })

    fireEvent.click(designer)

    const select = await waitFor(() => {
      const found = window.document.querySelector<HTMLSelectElement>(
        '[data-ae-l2-overlay] [data-ugui-action="projects.skin.select"]'
      )

      expect(found).not.toBeNull()

      return found as HTMLSelectElement
    })

    // The engine says a dropdown commits on change; a click must stay silent.
    fireEvent.click(select)
    expect($renderProfilePreviewId.get()).toBeNull()

    fireEvent.change(select, { target: { value: 'winxp' } })
    await waitFor(() => {
      expect($renderProfilePreviewId.get()).toBe('winxp')
    })
  })
})
