// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AE_EXECUTIVE_TAB_IDS, AE_EXECUTIVE_TABS } from './contract'
import type { AeExecutiveScene } from './scene'
import { AeScenePainter } from './scene-painter'

import { AeExecutiveWorkspace } from '.'

const getAeExecutiveScenes = vi.fn()
const getShellViewportScene = vi.fn()
const executeLucidExecutiveIntent = vi.fn()
const artifactGeneration = `sha256:${'a'.repeat(64)}`
const hash = (digit: string) => `sha256:${digit.repeat(64)}`

const labels = new Map(AE_EXECUTIVE_TABS.map(tab => [tab.id, tab.label]))

function navigation(tab: string) {
  return AE_EXECUTIVE_TAB_IDS.map(id => ({
    id: `${tab}-tab-${id}`,
    p: 'button' as const,
    a: { label: labels.get(id), primary: id === tab, role: 'tab' },
    on: { key: `shell.tab.${id}`, tap: `shell.tab.${id}` }
  }))
}

function ordinaryScene(tab: string): AeExecutiveScene {
  return {
    sceneVersion: '1.0.0',
    id: `run-${tab}`,
    root: `${tab}-root`,
    nodes: [
      { id: `${tab}-root`, p: 'column', kids: [`${tab}-title`, `${tab}-tabs`] },
      { id: `${tab}-title`, p: 'text', a: { text: `RUN ${tab.toUpperCase()}` } },
      { id: `${tab}-tabs`, p: 'row', kids: AE_EXECUTIVE_TAB_IDS.map(id => `${tab}-tab-${id}`) },
      ...navigation(tab)
    ]
  }
}

function nestedSystemScene(): AeExecutiveScene {
  return {
    sceneVersion: '1.0.0',
    id: 'canonical-system-shell',
    root: 'system-root',
    receipt: {
      revision: 41,
      reduced_motion: true,
      namedLosses: ['native-material:not-attested', 'host-window-mutation:prohibited']
    },
    nodes: [
      { id: 'system-root', p: 'column', kids: ['system-title', 'settings-app'] },
      { id: 'system-title', p: 'text', a: { text: 'Mochi Desktop · canonical nested Scene' } },
      {
        id: 'settings-app',
        p: 'button',
        a: { label: 'Open Settings', name: 'Open Settings' },
        on: { key: 'shell.applet.open.settings', tap: 'shell.applet.open.settings' }
      }
    ]
  }
}

function shellScene(nested: AeExecutiveScene = nestedSystemScene()): AeExecutiveScene {
  return {
    sceneVersion: '1.0.0',
    id: 'run-shell',
    root: 'shell-root',
    receipt: {
      revision: 17,
      reduced_motion: true,
      namedLosses: ['native-macos-material:not-attested']
    },
    nodes: [
      {
        id: 'shell-root',
        p: 'column',
        kids: ['shell-tabs', 'os-axis', 'surface-axis', 'system-within-system']
      },
      { id: 'shell-tabs', p: 'row', kids: AE_EXECUTIVE_TAB_IDS.map(id => `shell-tab-${id}`) },
      ...navigation('shell'),
      { id: 'os-axis', p: 'row', a: { name: 'OS selector' }, kids: ['os-macos', 'os-android'] },
      {
        id: 'os-macos',
        p: 'button',
        a: { label: 'macOS', name: 'OS macOS', primary: true },
        on: { key: 'shell.os.macos', tap: 'shell.os.macos' }
      },
      {
        id: 'os-android',
        p: 'button',
        a: { label: 'Android', name: 'OS Android' },
        on: { key: 'shell.os.android', tap: 'shell.os.android' }
      },
      { id: 'surface-axis', p: 'row', a: { name: 'SURFACE selector' }, kids: ['surface-desktop', 'surface-phone'] },
      {
        id: 'surface-desktop',
        p: 'button',
        a: { label: 'Desktop', name: 'SURFACE Desktop', primary: true },
        on: { key: 'shell.surface.macos-desktop', tap: 'shell.surface.macos-desktop' }
      },
      {
        id: 'surface-phone',
        p: 'button',
        a: { label: 'Phone', name: 'SURFACE Phone' },
        on: { key: 'shell.surface.iphone-14-pro', tap: 'shell.surface.iphone-14-pro' }
      },
      {
        id: 'system-within-system',
        p: 'native',
        a: {
          catalog: 'system-shell-scene',
          name: 'Recursive system shell',
          spec: { scene: nested }
        },
        layout: { height: '*' }
      }
    ]
  }
}

function batch(options: {
  shellState?: 'fresh' | 'stale' | 'unavailable'
  shell?: AeExecutiveScene
  reason?: string
} = {}) {
  const shellState = options.shellState ?? 'fresh'

  return {
    schema: 'ae-executive-scene-batch/2' as const,
    authority: 'none' as const,
    projector: 'run::executive_composer',
    generation: 1,
    document_hash: hash('1'),
    source_set_hash: hash('2'),
    observed_ms: 1_000,
    freshness: shellState === 'stale' ? 'stale' as const : 'fresh' as const,
    artifact_generation: artifactGeneration,
    scenes: AE_EXECUTIVE_TAB_IDS.map(tab => tab === 'shell'
      ? {
          tab,
          state: shellState,
          ...(shellState === 'unavailable' ? {} : { scene: options.shell ?? shellScene() }),
          ...(options.reason ? { reason: options.reason } : {})
        }
      : { tab, state: 'fresh' as const, scene: ordinaryScene(tab) })
  }
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/ae/shell']}>
      <Routes>
        <Route element={<AeExecutiveWorkspace />} path="ae/:tab" />
      </Routes>
    </MemoryRouter>
  )
}

beforeEach(() => {
  getAeExecutiveScenes.mockReset().mockResolvedValue(batch())
  getShellViewportScene.mockReset()
  executeLucidExecutiveIntent.mockReset()
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { executeLucidExecutiveIntent, getAeExecutiveScenes, getShellViewportScene }
  })
})

describe('canonical recursive SH[E]LL Scene', () => {
  it('consumes the envelope row with independent OS and SURFACE axes and no host-derived IPC', async () => {
    const view = renderShell()

    expect(await screen.findByText('Mochi Desktop · canonical nested Scene')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'OS macOS' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'SURFACE Desktop' })).toBeTruthy()
    expect(view.container.querySelector('[data-ugui-recursion-depth="1"]')).toBeTruthy()
    expect(screen.getAllByRole('status', { name: 'Visual loss receipt' })).toHaveLength(2)
    expect(getShellViewportScene).not.toHaveBeenCalled()
  })

  it('routes axis and nested app keyboard intents without mutating a hidden host shell', async () => {
    renderShell()
    await screen.findByText('Mochi Desktop · canonical nested Scene')

    fireEvent.click(screen.getByRole('button', { name: 'OS Android' }))
    expect(screen.getByText(/SHELL intent routed · shell\.os\.android .* host state unchanged/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'SURFACE Phone' }))
    expect(screen.getByText(/SHELL intent routed · shell\.surface\.iphone-14-pro .* host state unchanged/)).toBeTruthy()

    await act(async () => fireEvent.keyDown(screen.getByRole('button', { name: 'Open Settings' }), { key: 'Enter' }))
    expect(screen.getByText(/SHELL intent routed · shell\.applet\.open\.settings · revision 41 .* host state unchanged/)).toBeTruthy()
    expect(getShellViewportScene).not.toHaveBeenCalled()
    expect(executeLucidExecutiveIntent).not.toHaveBeenCalled()
    expect(getAeExecutiveScenes).toHaveBeenCalledTimes(1)
  })

  it('refuses recursive Scene embedding beyond the explicit bound', () => {
    const leaf = nestedSystemScene()
    const wrap = (id: string, child: AeExecutiveScene): AeExecutiveScene => ({
      sceneVersion: '1.0.0',
      id,
      root: `${id}-root`,
      nodes: [
        {
          id: `${id}-root`,
          p: 'native',
          a: { catalog: 'ugui-scene', name: id, spec: { scene: child } }
        }
      ]
    })
    const view = render(
      <AeScenePainter scene={wrap('level-one', wrap('level-two', wrap('level-three', leaf)))} />
    )

    expect(screen.getByText('UGUI refusal · scene-recursion-refused · depth-3')).toBeTruthy()
    expect(view.container.querySelectorAll('[data-ugui-recursion-depth]')).toHaveLength(2)
  })

  it('keeps stale canonical Scene visible and fails closed when the row is unavailable', async () => {
    getAeExecutiveScenes.mockResolvedValueOnce(batch({
      reason: 'shell-observation-stale',
      shellState: 'stale'
    }))
    const stale = renderShell()

    expect(await screen.findByText('Mochi Desktop · canonical nested Scene')).toBeTruthy()
    expect(screen.getByRole('status', { name: '' }).textContent).toContain('shell-observation-stale')
    expect(stale.container.querySelector('[data-ae-scene-posture="stale"]')).toBeTruthy()
    stale.unmount()

    getAeExecutiveScenes.mockResolvedValueOnce(batch({
      reason: 'canonical-shell-scene-unavailable',
      shellState: 'unavailable'
    }))
    renderShell()

    await waitFor(() => expect(screen.getByText('UGUI Scene unavailable · canonical-shell-scene-unavailable')).toBeTruthy())
    expect(screen.queryByText('Mochi Desktop · canonical nested Scene')).toBeNull()
  })
})
