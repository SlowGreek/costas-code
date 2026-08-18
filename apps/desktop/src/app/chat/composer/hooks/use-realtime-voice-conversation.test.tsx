import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { startRealtimeVoiceConnection } from '@/lib/realtime-voice'
import { $gateway } from '@/store/gateway'
import { setWorkbenchArtifact } from '@/store/workbench'

import { useRealtimeVoiceConversation } from './use-realtime-voice-conversation'

const close = vi.fn()
const setMuted = vi.fn()
const updateWorkbenchContext = vi.fn()

vi.mock('@/lib/realtime-voice', () => ({
  startRealtimeVoiceConnection: vi.fn(async () => ({ close, setMuted, updateWorkbenchContext }))
}))

vi.mock('@/store/notifications', () => ({
  notifyError: vi.fn()
}))

describe('useRealtimeVoiceConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setWorkbenchArtifact(null)
    $gateway.set({ request: vi.fn(async () => ({})) } as never)
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
      expect(updateWorkbenchContext).toHaveBeenCalledWith(expect.stringContaining('GPT Realtime'))
    )

    const connectionOptions = vi.mocked(startRealtimeVoiceConnection).mock.calls[0][0]
    connectionOptions.onTranscript?.({ id: 'item-user-1', role: 'user', text: 'Draw it as we talk.' })
    await waitFor(() =>
      expect($gateway.get()?.request).toHaveBeenCalledWith('voice.realtime.transcript', {
        session_id: 'runtime-session',
        item_id: 'item-user-1',
        role: 'user',
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
    options.onTranscript?.({ id: 'user-1', role: 'user', text: 'Keep this turn.' })

    await vi.advanceTimersByTimeAsync(2_000)

    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenLastCalledWith('voice.realtime.transcript', {
      session_id: 'runtime-session',
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
    await vi.advanceTimersByTimeAsync(500)
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

    const request = vi.fn(async (_method: string, params: Record<string, unknown>) => {
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
    await vi.advanceTimersByTimeAsync(500)
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
