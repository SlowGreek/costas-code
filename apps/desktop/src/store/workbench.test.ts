import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { requestOneShot } from '@/lib/oneshot'
import { $gateway } from '@/store/gateway'

import {
  $workbenchArtifact,
  parseWorkbenchGraph,
  recordWorkbenchTranscript,
  resetWorkbenchForTests
} from './workbench'

vi.mock('@/lib/oneshot', () => ({
  requestOneShot: vi.fn()
}))

describe('workbench ambient updater', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    resetWorkbenchForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    $gateway.set(null)
  })

  it('accepts strict semantic graph JSON and rejects renderer geometry', () => {
    expect(
      parseWorkbenchGraph('```json\n{"nodes":[{"id":"core","label":"Core","kind":"component"}],"edges":[]}\n```')
    ).toEqual({
      nodes: [{ id: 'core', label: 'Core', kind: 'component' }],
      edges: []
    })

    expect(() =>
      parseWorkbenchGraph('{"nodes":[{"id":"core","label":"Core","x":10}],"edges":[]}')
    ).toThrow('geometry')
  })

  it('debounces completed turns into one mute ambient update', async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'artifact.list') {
        return { artifacts: [], stored_session_id: 'stored-session' }
      }

      if (method === 'artifact.create') {
        return {
          artifact: {
            artifact_id: 'map.main',
            kind: 'map',
            semantic_rev: 1,
            view_rev: 1,
            payload: params.payload,
            view_state: { positions: {}, pinned: [] }
          }
        }
      }

      throw new Error(`unexpected ${method}`)
    })

    $gateway.set({ request } as never)
    vi.mocked(requestOneShot).mockResolvedValue(
      JSON.stringify({
        nodes: [
          { id: 'voice', label: 'GPT Realtime', kind: 'agent' },
          { id: 'canvas', label: 'Workbench canvas', kind: 'surface' }
        ],
        edges: [{ id: 'voice-canvas', from: 'voice', to: 'canvas', label: 'sees' }]
      })
    )

    recordWorkbenchTranscript('runtime-session', {
      id: 'user-1',
      role: 'user',
      text: 'I want realtime voice.'
    })
    recordWorkbenchTranscript('runtime-session', {
      id: 'assistant-1',
      role: 'assistant',
      text: 'And a canvas that updates while we talk.'
    })

    await vi.advanceTimersByTimeAsync(3_500)

    expect(requestOneShot).toHaveBeenCalledOnce()
    expect(vi.mocked(requestOneShot).mock.calls[0][0].input).toContain('I want realtime voice.')
    expect(vi.mocked(requestOneShot).mock.calls[0][0].input).toContain('canvas that updates')
    expect(request).toHaveBeenCalledWith(
      'artifact.create',
      expect.objectContaining({
        session_id: 'runtime-session',
        artifact_id: 'map.main',
        updated_by: 'ambient'
      })
    )
    expect($workbenchArtifact.get()?.payload.nodes).toHaveLength(2)
  })

  it('does not hot-loop an expensive ambient inference after failure', async () => {
    $gateway.set({
      request: vi.fn(async (method: string) =>
        method === 'artifact.list' ? { artifacts: [] } : Promise.reject(new Error(`unexpected ${method}`))
      )
    } as never)
    vi.mocked(requestOneShot).mockRejectedValue(new Error('provider unavailable'))

    recordWorkbenchTranscript('runtime-session', {
      id: 'user-1',
      role: 'user',
      text: 'The first thought.'
    })
    await vi.advanceTimersByTimeAsync(3_500)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(requestOneShot).toHaveBeenCalledOnce()

    recordWorkbenchTranscript('runtime-session', {
      id: 'user-2',
      role: 'user',
      text: 'A new thought should permit one retry.'
    })
    await vi.advanceTimersByTimeAsync(3_500)

    expect(requestOneShot).toHaveBeenCalledTimes(2)
  })
})
