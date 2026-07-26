// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetExecutiveScenesForTests } from './scene'

import { AeExecutiveWorkspace } from '.'

const getShellViewportScene = vi.fn()
const getAeExecutiveScenes = vi.fn()

const batchTabs = ['home', 'dashboard', 'lucid', 'quine', 'scores', 'metrics', 'logs', 'studio', 'settings', 'marketplace']

const executiveBatch = {
  schema: 'ae-executive-scene-batch/1',
  authority: 'none',
  projector: 'test',
  scenes: batchTabs.map(tab => ({
    tab,
    scene: {
      sceneVersion: '1.0.0',
      id: `run-${tab}`,
      root: `${tab}-root`,
      nodes: [
        { id: `${tab}-root`, p: 'column', kids: [`${tab}-tabs`] },
        { id: `${tab}-tabs`, p: 'row', kids: batchTabs.map(id => `${tab}-tab-${id}`) },
        ...batchTabs.map(id => ({
          id: `${tab}-tab-${id}`,
          p: 'button',
          a: { label: ({
            home: '[H]OME', dashboard: '[D]ASHBOARD', lucid: '[L]UCID', quine: '[Q]UINE',
            scores: 'S[C]ORES', metrics: '[M]ETRICS', logs: 'L[O]GS', studio: 'S[T]UDIO',
            settings: '[S]ETTINGS', marketplace: 'MA[R]KETPLACE'
          } as Record<string, string>)[id], role: 'tab' },
          on: { tap: `shell.tab.${id}` },
          layout: { height: 1 }
        }))
      ]
    }
  }))
}

const shellResponse = {
  schema: 'ae-shell-viewport-scene/1',
  authority: 'none',
  model: {
    shell: { id: 'android-shell' },
    surface: { id: 'google-pixel-9' },
    target: { id: 'android-arm64-v8a' },
    selector: {
      shells: ['android-shell', 'macos-shell'],
      surfaces: ['google-pixel-9'],
      targets: ['android-arm64-v8a']
    }
  },
  scene: {
    sceneVersion: '1.0.0',
    id: 'shell-viewport',
    root: 'root',
    nodes: [
      { id: 'root', p: 'column', kids: ['warning', 'frame'] },
      { id: 'warning', p: 'text', a: { text: 'STRUCTURAL PROJECTION — NOT A PHYSICAL RUN' } },
      {
        id: 'frame',
        p: 'native',
        a: {
          catalog: 'shell-structural-viewport',
          model: {
            shell_id: 'android-shell',
            form_factor: 'handset',
            geometry: { viewport: { width: 360, height: 808 } },
            chrome: ['status-bar'],
            warning: 'STRUCTURAL PROJECTION — NOT A PHYSICAL RUN'
          }
        }
      }
    ],
    receipt: { authority: 'none' }
  }
}

beforeEach(() => {
  resetExecutiveScenesForTests()
  getAeExecutiveScenes.mockReset().mockResolvedValue(executiveBatch)
  getShellViewportScene.mockReset().mockResolvedValue(shellResponse)
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      getAeExecutiveScenes,
      getShellViewportScene
    }
  })
})

describe('SH[E]LL developer viewport', () => {
  it('renders the host-derived UGUI Scene without pretending it is in the RUN batch', async () => {
    render(
      <MemoryRouter initialEntries={['/ae/shell']}>
        <Routes>
          <Route element={<AeExecutiveWorkspace />} path="ae/:tab" />
        </Routes>
      </MemoryRouter>
    )

    expect(await screen.findAllByText('STRUCTURAL PROJECTION — NOT A PHYSICAL RUN')).not.toHaveLength(0)
    expect(screen.getByText('Same semantic GenUI experience')).toBeTruthy()
    await waitFor(() =>
      expect(getShellViewportScene).toHaveBeenCalledWith({
        shell_id: 'android-shell',
        surface_profile_id: 'google-pixel-9',
        target_id: 'android-arm64-v8a'
      })
    )
    expect(screen.getByText(/physical evidence not implied/i)).toBeTruthy()
    await waitFor(() => expect(getAeExecutiveScenes).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/ae-executive-scene-missing:shell/)).toBeNull()
  })
})
