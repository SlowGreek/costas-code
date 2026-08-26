import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $workbenchLayout,
  $workbenchSelection,
  resetWorkbenchForTests,
  setWorkbenchArtifact,
  setWorkbenchDrawing,
  setWorkbenchLayout,
  setWorkbenchSelection,
  type WorkbenchArtifact
} from '@/store/workbench'

import {
  startWorkbenchContextSync,
  summarizeWorkbench,
  WORKBENCH_CONTEXT_DEBOUNCE_MS
} from './workbench-context-sync'

const artifact = (rev = 1): WorkbenchArtifact => ({
  artifact_id: 'a1',
  kind: 'map',
  payload: {
    edges: [{ from: 'planner', id: 'e1', label: 'drives', to: 'controller' }],
    nodes: [
      { id: 'planner', kind: 'agent', label: 'Planner' },
      { id: 'controller', kind: 'system', label: 'Controller' }
    ]
  },
  semantic_rev: rev,
  view_rev: 1,
  view_state: {}
})

const layout = {
  height: 600,
  positions: { controller: { x: 450, y: 300 }, planner: { x: 100, y: 90 } },
  width: 900
}

/** Manual clock so debounce behaviour is asserted, not slept through. */
const makeScheduler = () => {
  const queue = new Map<number, () => void>()
  let next = 1

  return {
    clearTimeout: (handle: number) => {
      queue.delete(handle)
    },
    run: () => {
      const pending = [...queue.entries()]
      queue.clear()
      pending.forEach(([, fn]) => {
        fn()
      })
    },
    setTimeout: (fn: () => void, _ms: number) => {
      const handle = next++
      queue.set(handle, fn)

      return handle
    },
    get size() {
      return queue.size
    }
  }
}

beforeEach(() => {
  resetWorkbenchForTests()
})

describe('summarizeWorkbench', () => {
  it('includes coarse locations and the pointing target', () => {
    const parsed = JSON.parse(
      summarizeWorkbench(artifact(), { layout, selection: 'controller' })
    ) as { nodes: { location?: string }[]; pointing_at: null | string }

    expect(parsed.pointing_at).toBe('controller')
    expect(parsed.nodes.map(node => node.location)).toEqual(['upper left', 'centre'])
  })

  it('does not throw for non-map kinds', () => {
    const timeline = { ...artifact(), kind: 'timeline', payload: { items: [{ id: 'i', label: 'x' }] } }

    expect(() => summarizeWorkbench(timeline as unknown as WorkbenchArtifact)).not.toThrow()
  })
})

describe('startWorkbenchContextSync', () => {
  it('refreshes continuation truth while appending transitions instead of rewriting the prompt', () => {
    // Codex pattern: one snapshot at startup, semantic events after. Rewriting
    // the full instructions on every canvas change invalidates prompt caching
    // and tells the model only WHAT IS, never WHAT CHANGED.
    setWorkbenchArtifact(artifact(1))
    setWorkbenchLayout(layout)

    const push = vi.fn()
    const appendEvent = vi.fn()
    const scheduler = makeScheduler()
    const stop = startWorkbenchContextSync({ appendEvent, push, scheduler })

    // Ignore initial subscription delivery: the connection has its explicit
    // startup snapshot in use-realtime-voice-conversation.ts.
    push.mockClear()
    appendEvent.mockClear()

    setWorkbenchArtifact({
      ...artifact(2),
      payload: {
        ...artifact(2).payload,
        nodes: [...artifact(2).payload.nodes, { id: 'memory', label: 'Memory' }]
      }
    })
    scheduler.run()

    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0][0]).toContain('Memory')
    expect(appendEvent).toHaveBeenCalledTimes(1)
    expect(appendEvent.mock.calls[0][0]).toContain('Memory')
    expect(appendEvent.mock.calls[0][0]).not.toContain('Current canvas state')
    stop()
  })

  it('appends user selection as world state without generating a response', () => {
    setWorkbenchArtifact(artifact())
    setWorkbenchLayout(layout)

    const push = vi.fn()
    const appendEvent = vi.fn()
    const scheduler = makeScheduler()
    const stop = startWorkbenchContextSync({ appendEvent, push, scheduler })

    push.mockClear()
    appendEvent.mockClear()
    setWorkbenchSelection('planner')

    expect(push).toHaveBeenCalledTimes(1)
    expect(appendEvent).toHaveBeenCalledTimes(1)
    expect(appendEvent.mock.calls[0][0]).toContain('pointing at Planner')
    expect(appendEvent.mock.calls[0][0]).toContain('id planner')
    stop()
  })

  it('appends drawing lifecycle as short events, not repeated snapshots', () => {
    setWorkbenchArtifact(artifact())
    setWorkbenchLayout(layout)

    const push = vi.fn()
    const appendEvent = vi.fn()
    const scheduler = makeScheduler()
    const stop = startWorkbenchContextSync({ appendEvent, push, scheduler })

    appendEvent.mockClear()
    setWorkbenchDrawing(true)
    setWorkbenchDrawing(false)

    expect(appendEvent.mock.calls.map(call => call[0])).toEqual([
      'The canvas started updating.',
      'The canvas finished updating.'
    ])
    expect(appendEvent.mock.calls.flat().join(' ')).not.toContain('Current canvas state')
    stop()
  })

  it('appends immediately when the selection changes', () => {
    setWorkbenchArtifact(artifact())
    setWorkbenchLayout(layout)

    const push = vi.fn()
    const appendEvent = vi.fn()
    const scheduler = makeScheduler()
    const stop = startWorkbenchContextSync({ appendEvent, push, scheduler })

    push.mockClear()
    appendEvent.mockClear()
    setWorkbenchSelection('planner')

    expect(push).toHaveBeenCalledTimes(1)
    expect(appendEvent).toHaveBeenCalledTimes(1)
    expect(appendEvent.mock.calls[0][0]).toContain('pointing at Planner')
    expect(appendEvent.mock.calls[0][0]).toContain('id planner')
    stop()
  })

  it('coalesces layout churn into one append', () => {
    setWorkbenchArtifact(artifact())
    setWorkbenchLayout(layout)

    const push = vi.fn()
    const appendEvent = vi.fn()
    const scheduler = makeScheduler()
    const stop = startWorkbenchContextSync({ appendEvent, push, scheduler })

    push.mockClear()
    appendEvent.mockClear()

    for (let index = 0; index < 10; index++) {
      setWorkbenchLayout({
        ...layout,
        positions: { ...layout.positions, planner: { x: 100 + index * 30, y: 90 } }
      })
    }

    expect(appendEvent).not.toHaveBeenCalled()
    scheduler.run()
    expect(push).toHaveBeenCalledTimes(1)
    expect(appendEvent).toHaveBeenCalledTimes(1)
    stop()
  })

  it('appends when the artifact changes', () => {
    setWorkbenchArtifact(artifact(1))
    setWorkbenchLayout(layout)

    const push = vi.fn()
    const appendEvent = vi.fn()
    const scheduler = makeScheduler()
    const stop = startWorkbenchContextSync({ appendEvent, push, scheduler })

    push.mockClear()
    appendEvent.mockClear()
    setWorkbenchArtifact(artifact(2))
    scheduler.run()

    expect(push).toHaveBeenCalledTimes(1)
    expect(appendEvent).toHaveBeenCalledTimes(1)
    expect(appendEvent.mock.calls[0][0]).toContain('"revision":2')
    stop()
  })

  it('appends when the pin/hide overlay changes via a layout tick', () => {
    setWorkbenchArtifact(artifact())
    setWorkbenchLayout(layout)

    const push = vi.fn()
    const appendEvent = vi.fn()
    const scheduler = makeScheduler()
    let overlay: { hidden?: string[]; pinned?: string[] } = {}
    const stop = startWorkbenchContextSync({ appendEvent, overlay: () => overlay, push, scheduler })

    push.mockClear()
    appendEvent.mockClear()
    overlay = { pinned: ['controller'] }
    setWorkbenchLayout({ ...layout })
    scheduler.run()

    expect(push).toHaveBeenCalledTimes(1)
    expect(appendEvent).toHaveBeenCalledTimes(1)
    expect(appendEvent.mock.calls[0][0]).toContain('"pinned":true')
    stop()
  })

  it('suppresses byte-identical repeats', () => {
    setWorkbenchArtifact(artifact())
    setWorkbenchLayout(layout)

    const push = vi.fn()
    const scheduler = makeScheduler()
    const stop = startWorkbenchContextSync({ push, scheduler })

    push.mockClear()
    setWorkbenchLayout({ ...layout })
    scheduler.run()

    expect(push).not.toHaveBeenCalled()
    stop()
  })

  it('stops pushing after unsubscribe', () => {
    setWorkbenchArtifact(artifact())
    setWorkbenchLayout(layout)

    const push = vi.fn()
    const scheduler = makeScheduler()
    const stop = startWorkbenchContextSync({ push, scheduler })

    stop()
    push.mockClear()
    setWorkbenchSelection('controller')

    expect(push).not.toHaveBeenCalled()
  })

  it('has a real debounce window', () => {
    expect(WORKBENCH_CONTEXT_DEBOUNCE_MS).toBeGreaterThan(0)
  })

  it('clears a selection the new artifact no longer contains', () => {
    setWorkbenchArtifact(artifact())
    setWorkbenchSelection('planner')
    setWorkbenchArtifact({
      ...artifact(2),
      payload: { edges: [], nodes: [{ id: 'controller', label: 'Controller' }] }
    })

    expect($workbenchSelection.get()).toBeNull()
    expect($workbenchLayout.get()).not.toBeUndefined()
  })
})
