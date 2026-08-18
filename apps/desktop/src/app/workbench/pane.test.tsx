import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $gateway } from '@/store/gateway'
import { $activeSessionId } from '@/store/session'
import { setWorkbenchArtifact } from '@/store/workbench'

import { WorkbenchPane } from './pane'

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {}
  disconnect = vi.fn()
  observe = vi.fn((element: Element) => {
    this.callback(
      [{ target: element, contentRect: { width: 800, height: 500 } } as ResizeObserverEntry],
      this as never
    )
  })
  unobserve = vi.fn()
}

describe('WorkbenchPane', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    $activeSessionId.set('runtime-session')
    $gateway.set({ request: vi.fn(async () => ({ artifacts: [] })) } as never)
    setWorkbenchArtifact(null)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    $gateway.set(null)
    $activeSessionId.set(null)
    setWorkbenchArtifact(null)
  })

  it('renders the ambient semantic graph with persisted positions', () => {
    setWorkbenchArtifact({
      artifact_id: 'map.main',
      kind: 'map',
      semantic_rev: 2,
      view_rev: 1,
      payload: {
        nodes: [
          { id: 'voice', label: 'GPT Realtime', kind: 'agent' },
          { id: 'canvas', label: 'Workbench canvas', kind: 'surface' }
        ],
        edges: [{ id: 'voice-canvas', from: 'voice', to: 'canvas', label: 'sees' }]
      },
      view_state: {
        positions: {
          voice: { x: 180, y: 220 },
          canvas: { x: 540, y: 220 }
        },
        pinned: ['voice', 'canvas']
      }
    })

    render(<WorkbenchPane />)

    expect(screen.getByText('GPT Realtime')).toBeTruthy()
    expect(screen.getByText('Workbench canvas')).toBeTruthy()
    expect(screen.getByText('sees')).toBeTruthy()
    expect(screen.getByTestId('workbench-canvas')).toBeTruthy()
  })

  it('shows the ideation prompt before the first ambient update', () => {
    render(<WorkbenchPane />)

    expect(screen.getByText('Start talking. The map will build itself.')).toBeTruthy()
  })
})
