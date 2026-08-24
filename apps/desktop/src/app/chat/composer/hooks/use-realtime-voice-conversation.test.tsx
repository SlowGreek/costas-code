import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { emitGatewayEvent } from '@/contrib/events'
import { startRealtimeVoiceConnection } from '@/lib/realtime-voice'
import { $gateway } from '@/store/gateway'
import { $realtimeMissions } from '@/store/realtime-mission'
import { setWorkbenchArtifact } from '@/store/workbench'

import { useRealtimeVoiceConversation } from './use-realtime-voice-conversation'

const close = vi.fn()
const appendContext = vi.fn()
const setMuted = vi.fn()
const updateWorkbenchContext = vi.fn()
const awaitPendingTranscription = vi.fn(async () => {})
const stopTurn = vi.fn()
const seedHistory = vi.fn()
const resumeMission = vi.fn(() => true)

vi.mock('@/lib/realtime-voice', () => ({
  startRealtimeVoiceConnection: vi.fn(async () => ({
    appendContext,
    awaitPendingTranscription,
    close,
    resumeMission,
    seedHistory,
    setMuted,
    stopTurn,
    updateWorkbenchContext
  }))
}))

vi.mock('@/store/notifications', () => ({
  notifyError: vi.fn()
}))

describe('useRealtimeVoiceConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    awaitPendingTranscription.mockImplementation(async () => {})
    setWorkbenchArtifact(null)
    $realtimeMissions.set({})
    $gateway.set({ request: vi.fn(async () => ({})) } as never)
  })

  it('gates a tool call on the real transcription event, with no fixed sleep', async () => {
    let releaseTranscription!: () => void
    awaitPendingTranscription.mockImplementation(
      () => new Promise<void>(resolve => (releaseTranscription = resolve))
    )

    const request = vi.fn(async () => ({ inserted: true }))
    $gateway.set({ request } as never)

    const hook = renderHook(() =>
      useRealtimeVoiceConversation({ enabled: false, runtimeSessionId: 'runtime-session' })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    const options = vi.mocked(startRealtimeVoiceConnection).mock.calls[0][0]
    const settled = vi.fn()
    void options.beforeToolCall?.().then(settled)
    await act(async () => {
      await Promise.resolve()
    })

    // No amount of waiting releases it; only the transcription event does.
    expect(settled).not.toHaveBeenCalled()

    releaseTranscription()
    await act(async () => {
      await Promise.resolve()
    })
    expect(settled).toHaveBeenCalled()
  })

  it('seeds recent conversation so voice continues instead of starting cold', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.history') {
        return {
          messages: [
            { role: 'user', content: 'Lets design the workbench.' },
            { role: 'assistant', content: 'Voice owns the turn.' },
            { role: 'system', content: 'ignored' },
            { role: 'user', content: '   ' }
          ]
        }
      }

      return {}
    })

    $gateway.set({ request } as never)

    const hook = renderHook(() =>
      useRealtimeVoiceConversation({ enabled: false, runtimeSessionId: 'runtime-session' })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    expect(request).toHaveBeenCalledWith('session.history', { session_id: 'runtime-session' })
    // Only real user/assistant turns are replayed; system and blank are dropped.
    expect(seedHistory).toHaveBeenCalledWith([
      { id: 'seed-0', role: 'user', text: 'Lets design the workbench.' },
      { id: 'seed-1', role: 'assistant', text: 'Voice owns the turn.' }
    ])
  })

  it('still connects when history cannot be loaded', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.history') {
        throw new Error('gateway busy')
      }

      return {}
    })

    $gateway.set({ request } as never)

    const hook = renderHook(() =>
      useRealtimeVoiceConversation({ enabled: false, runtimeSessionId: 'runtime-session' })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    // Losing context degrades the conversation; it must not break the session.
    await waitFor(() => expect(hook.result.current.status).toBe('listening'))
    expect(seedHistory).not.toHaveBeenCalled()
  })

  it('describes a non-map canvas without crashing the connection', async () => {
    // summarizeWorkbench used to read payload.nodes unconditionally, so
    // starting voice with a timeline or sketch on screen threw inside connect
    // and silently cost the model all knowledge of what was displayed.
    $gateway.set({ request: vi.fn(async () => ({})) } as never)
    setWorkbenchArtifact({
      artifact_id: 'map.main',
      kind: 'timeline',
      semantic_rev: 3,
      view_rev: 1,
      payload: { items: [{ id: 'p1', label: 'Phase 1', order: 0 }] },
      view_state: {}
    } as never)

    const hook = renderHook(() =>
      useRealtimeVoiceConversation({ enabled: false, runtimeSessionId: 'runtime-session' })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    await waitFor(() => expect(hook.result.current.status).toBe('listening'))
    expect(updateWorkbenchContext).toHaveBeenCalledWith(expect.stringContaining('timeline'))
    expect(updateWorkbenchContext).toHaveBeenCalledWith(expect.stringContaining('Phase 1'))
  })

  it('exposes a manual stop-turn interrupt to the composer controls', async () => {
    const hook = renderHook(() =>
      useRealtimeVoiceConversation({ enabled: false, runtimeSessionId: 'runtime-session' })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    act(() => {
      hook.result.current.stopTurn?.()
    })

    expect(stopTurn).toHaveBeenCalled()
  })

  it('resumes a ready research mission exactly once at a safe voice boundary', async () => {
    const hook = renderHook(() =>
      useRealtimeVoiceConversation({ enabled: false, runtimeSessionId: 'runtime-session' })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    const options = vi.mocked(startRealtimeVoiceConnection).mock.calls[0][0]

    const mission = {
      artifactId: 'research_1',
      delegationId: 'deleg_1',
      label: 'Claude Code architecture',
      missionId: 'mission_1',
      runtimeSessionId: 'runtime-session'
    }

    act(() => options.onResearchDispatched?.(mission))
    expect($realtimeMissions.get()['runtime-session']?.state).toBe('researching')

    act(() => {
      emitGatewayEvent({
        type: 'voice.realtime.research.ready',
        session_id: 'runtime-session',
        payload: {
          mission_id: 'mission_1',
          artifact_id: 'research_1',
          delegation_id: 'deleg_1'
        }
      })
    })

    expect(resumeMission).toHaveBeenCalledOnce()
    expect(resumeMission).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'response.create' })
    )
    expect($realtimeMissions.get()['runtime-session']?.state).toBe('resuming')

    act(() => {
      emitGatewayEvent({
        type: 'voice.realtime.research.ready',
        session_id: 'runtime-session',
        payload: {
          mission_id: 'mission_1',
          artifact_id: 'research_1',
          delegation_id: 'deleg_1'
        }
      })
    })
    expect(resumeMission).toHaveBeenCalledOnce()
  })

  it('waits for an active provider response and cancels auto-resume on barge-in', async () => {
    const hook = renderHook(() =>
      useRealtimeVoiceConversation({ enabled: false, runtimeSessionId: 'runtime-session' })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    const options = vi.mocked(startRealtimeVoiceConnection).mock.calls[0][0]

    const mission = {
      artifactId: 'research_1',
      delegationId: 'deleg_1',
      label: 'Claude Code architecture',
      missionId: 'mission_1',
      runtimeSessionId: 'runtime-session'
    }

    act(() => {
      options.onResearchDispatched?.(mission)
      options.onProviderResponseStarted?.()
      emitGatewayEvent({
        type: 'voice.realtime.research.ready',
        session_id: 'runtime-session',
        payload: {
          mission_id: 'mission_1',
          artifact_id: 'research_1',
          delegation_id: 'deleg_1'
        }
      })
    })
    expect(resumeMission).not.toHaveBeenCalled()
    expect($realtimeMissions.get()['runtime-session']?.state).toBe('awaiting_boundary')

    act(() => {
      options.onUserSpeechStarted?.()
      options.onProviderResponseEnded?.('cancelled', false)
      options.onUserSpeechEnded?.()
    })

    expect(resumeMission).not.toHaveBeenCalled()
    expect($realtimeMissions.get()['runtime-session']?.state).toBe('cancelled')
  })

  it('starts and ends the WebRTC session from the existing conversation controls', async () => {
    const hook = renderHook(() =>
      useRealtimeVoiceConversation({
        enabled: false,
        runtimeSessionId: 'runtime-session'
      })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    await waitFor(() => expect(hook.result.current.status).toBe('listening'))
    expect(startRealtimeVoiceConnection).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeSessionId: 'runtime-session' })
    )

    act(() => {
      setWorkbenchArtifact({
        artifact_id: 'map.main',
        kind: 'map',
        semantic_rev: 2,
        view_rev: 1,
        payload: {
          nodes: [{ id: 'voice', label: 'GPT Realtime' }],
          edges: []
        },
        view_state: {}
      })
    })
    await waitFor(() =>
      expect(appendContext).toHaveBeenCalledWith(expect.stringContaining('GPT Realtime'))
    )

    const connectionOptions = vi.mocked(startRealtimeVoiceConnection).mock.calls[0][0]
    connectionOptions.onTranscript?.({
      connectionId: 'voice-connection-1',
      id: 'item-user-1',
      role: 'user',
      semanticTurnId: 'voice-turn-1',
      text: 'Draw it as we talk.'
    })
    await waitFor(() =>
      expect($gateway.get()?.request).toHaveBeenCalledWith('voice.realtime.transcript', {
        session_id: 'runtime-session',
        connection_id: 'voice-connection-1',
        item_id: 'item-user-1',
        role: 'user',
        semantic_turn_id: 'voice-turn-1',
        text: 'Draw it as we talk.'
      })
    )

    act(() => hook.result.current.toggleMute())
    expect(setMuted).toHaveBeenCalledWith(true)
    expect(hook.result.current.muted).toBe(true)

    act(() => hook.result.current.end())
    expect(close).toHaveBeenCalledOnce()
    expect(hook.result.current.status).toBe('idle')
  })

  it('retries durable transcript writes before surfacing failure', async () => {
    vi.useFakeTimers()

    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('gateway reconnecting'))
      .mockRejectedValueOnce(new Error('gateway reconnecting'))
      .mockResolvedValue({ inserted: true, message_id: 42 })

    $gateway.set({ request } as never)

    const hook = renderHook(() =>
      useRealtimeVoiceConversation({ enabled: false, runtimeSessionId: 'runtime-session' })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    const options = vi.mocked(startRealtimeVoiceConnection).mock.calls[0][0]
    options.onTranscript?.({
      connectionId: 'voice-connection-retry',
      id: 'user-1',
      role: 'user',
      text: 'Keep this turn.'
    })

    await vi.advanceTimersByTimeAsync(2_000)

    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenLastCalledWith('voice.realtime.transcript', {
      session_id: 'runtime-session',
      connection_id: 'voice-connection-retry',
      item_id: 'user-1',
      role: 'user',
      text: 'Keep this turn.'
    })
    vi.useRealTimers()
  })

  it('retries an older failed transcript before allowing visualize', async () => {
    vi.useFakeTimers()
    let firstAttempts = 0

    const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
      if (params.item_id === 'first') {
        firstAttempts += 1

        if (firstAttempts <= 3) {
          throw new Error('gateway reconnecting')
        }
      }

      return { inserted: true }
    })

    $gateway.set({ request } as never)

    const hook = renderHook(() =>
      useRealtimeVoiceConversation({ enabled: false, runtimeSessionId: 'runtime-session' })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    const options = vi.mocked(startRealtimeVoiceConnection).mock.calls[0][0]
    options.onTranscript?.({ id: 'first', role: 'user', text: 'First turn.' })
    await vi.advanceTimersByTimeAsync(2_000)
    options.onTranscript?.({ id: 'second', role: 'assistant', text: 'Second turn.' })
    await act(async () => {
      await Promise.resolve()
    })

    const barrier = options.beforeToolCall?.()
    await vi.advanceTimersByTimeAsync(2_000)
    await barrier

    expect(firstAttempts).toBe(4)
    expect(request).toHaveBeenCalledWith('voice.realtime.transcript', {
      session_id: 'runtime-session',
      item_id: 'first',
      role: 'user',
      text: 'First turn.'
    })
    vi.useRealTimers()
  })

  it('never drops later failed transcripts when the first retry still fails', async () => {
    vi.useFakeTimers()
    const attempts = { first: 0, second: 0 }

    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      // Ignore the history seed the hook performs on connect.
      if (method !== 'voice.realtime.transcript') {
        return {}
      }

      const id = String(params.item_id) as keyof typeof attempts
      attempts[id] += 1
      const failThrough = id === 'first' ? 6 : 3

      if (attempts[id] <= failThrough) {
        throw new Error(`${id} still failing`)
      }

      return { inserted: true }
    })

    $gateway.set({ request } as never)

    const hook = renderHook(() =>
      useRealtimeVoiceConversation({ enabled: false, runtimeSessionId: 'runtime-session' })
    )

    await act(async () => {
      await hook.result.current.start()
    })

    const options = vi.mocked(startRealtimeVoiceConnection).mock.calls[0][0]
    options.onTranscript?.({ id: 'first', role: 'user', text: 'First.' })
    await vi.advanceTimersByTimeAsync(2_000)
    options.onTranscript?.({ id: 'second', role: 'assistant', text: 'Second.' })
    await vi.advanceTimersByTimeAsync(2_000)

    const firstBarrier = options.beforeToolCall?.()
    const firstRejection = expect(firstBarrier).rejects.toThrow('first still failing')
    await vi.advanceTimersByTimeAsync(2_500)
    await firstRejection

    const secondBarrier = options.beforeToolCall?.()
    await vi.advanceTimersByTimeAsync(2_500)
    await expect(secondBarrier).resolves.toBeUndefined()

    expect(attempts).toEqual({ first: 7, second: 4 })
    vi.useRealTimers()
  })

  it('waits for the wake listener to release the microphone before connecting', async () => {
    let release!: () => void
    const beforeConnect = vi.fn(() => new Promise<void>(resolve => (release = resolve)))

    const hook = renderHook(() =>
      useRealtimeVoiceConversation({
        beforeConnect,
        enabled: false,
        runtimeSessionId: 'runtime-session'
      })
    )

    let startPromise!: Promise<void>
    await act(async () => {
      startPromise = hook.result.current.start()
      await Promise.resolve()
    })

    expect(beforeConnect).toHaveBeenCalledOnce()
    expect(startRealtimeVoiceConnection).not.toHaveBeenCalled()

    await act(async () => {
      release()
      await startPromise
    })

    expect(startRealtimeVoiceConnection).toHaveBeenCalledOnce()
  })
})
