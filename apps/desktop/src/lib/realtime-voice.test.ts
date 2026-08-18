import { describe, expect, it, vi } from 'vitest'

import {
  createPendingTranscriptionTracker,
  routeRealtimeServerEvent,
  startRealtimeVoiceConnection
} from './realtime-voice'

describe('createPendingTranscriptionTracker', () => {
  it('adds no latency when no transcription is in flight', async () => {
    vi.useFakeTimers()
    const tracker = createPendingTranscriptionTracker()
    const settled = vi.fn()

    void tracker.awaitSettled().then(settled)
    await Promise.resolve()

    // Resolved without any timer having to fire.
    expect(settled).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('gates until the real transcription event lands, not on a fixed delay', async () => {
    vi.useFakeTimers()
    const tracker = createPendingTranscriptionTracker()
    const settled = vi.fn()

    tracker.markPending()
    void tracker.awaitSettled().then(settled)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(settled).not.toHaveBeenCalled()

    tracker.settle()
    await Promise.resolve()
    expect(settled).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('falls back to a bounded timeout when the event never arrives', async () => {
    vi.useFakeTimers()
    const tracker = createPendingTranscriptionTracker()
    const settled = vi.fn()

    tracker.markPending()
    void tracker.awaitSettled().then(settled)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('waits for every in-flight utterance before releasing', async () => {
    vi.useFakeTimers()
    const tracker = createPendingTranscriptionTracker()
    const settled = vi.fn()

    tracker.markPending()
    tracker.markPending()
    void tracker.awaitSettled().then(settled)

    tracker.settle()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    tracker.settle()
    await Promise.resolve()
    expect(settled).toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('barge-in audio flushing', () => {
  const deps = (overrides: Record<string, unknown> = {}) => ({
    request: vi.fn(),
    runtimeSessionId: 'runtime-session',
    send: vi.fn(),
    ...overrides
  })

  it('flushes buffered assistant audio when the user starts speaking', async () => {
    const clearAssistantAudio = vi.fn()

    await routeRealtimeServerEvent(
      { type: 'input_audio_buffer.speech_started' },
      deps({ clearAssistantAudio })
    )

    expect(clearAssistantAudio).toHaveBeenCalled()
  })

  it('tracks assistant speaking state from output buffer events', async () => {
    const onAssistantAudioStarted = vi.fn()
    const onAssistantAudioEnded = vi.fn()
    const shared = deps({ onAssistantAudioEnded, onAssistantAudioStarted })

    await routeRealtimeServerEvent({ type: 'output_audio_buffer.started' }, shared)
    expect(onAssistantAudioStarted).toHaveBeenCalled()

    await routeRealtimeServerEvent({ type: 'output_audio_buffer.stopped' }, shared)
    expect(onAssistantAudioEnded).toHaveBeenCalled()
  })

  it('treats a completed response as the end of assistant audio', async () => {
    const onAssistantAudioEnded = vi.fn()

    await routeRealtimeServerEvent({ type: 'response.done' }, deps({ onAssistantAudioEnded }))

    expect(onAssistantAudioEnded).toHaveBeenCalled()
  })
})

describe('routeRealtimeServerEvent', () => {
  it('marks a committed utterance pending and settles it on transcription', async () => {
    const pendingTranscription = createPendingTranscriptionTracker()

    const deps = {
      pendingTranscription,
      request: vi.fn(),
      runtimeSessionId: 'runtime-session',
      send: vi.fn()
    }

    await routeRealtimeServerEvent({ type: 'input_audio_buffer.committed' }, deps)
    const settled = vi.fn()
    void pendingTranscription.awaitSettled().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    await routeRealtimeServerEvent(
      {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        transcript: 'Voice and canvas are separate consumers.'
      },
      deps
    )
    await Promise.resolve()
    expect(settled).toHaveBeenCalled()
  })

  it('settles a failed transcription so visualize is never wedged', async () => {
    const pendingTranscription = createPendingTranscriptionTracker()

    const deps = {
      pendingTranscription,
      request: vi.fn(),
      runtimeSessionId: 'runtime-session',
      send: vi.fn()
    }

    await routeRealtimeServerEvent({ type: 'input_audio_buffer.committed' }, deps)
    const settled = vi.fn()
    void pendingTranscription.awaitSettled().then(settled)
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    await routeRealtimeServerEvent(
      { type: 'conversation.item.input_audio_transcription.failed', item_id: 'item-1' },
      deps
    )
    await Promise.resolve()
    expect(settled).toHaveBeenCalled()
  })

  it('bridges session_snapshot function calls to the Hermes gateway', async () => {
    const request = vi.fn(async () => ({
      artifacts: [{ artifact_id: 'map.main', kind: 'map', semantic_rev: 2, view_rev: 1 }],
      stored_session_id: 'stored-session'
    }))

    const send = vi.fn()

    await routeRealtimeServerEvent(
      {
        type: 'response.function_call_arguments.done',
        call_id: 'call-1',
        name: 'session_snapshot',
        arguments: '{}'
      },
      {
        request,
        runtimeSessionId: 'runtime-session',
        send
      }
    )

    expect(request).toHaveBeenCalledWith('artifact.list', { session_id: 'runtime-session' })
    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: JSON.stringify({
          artifacts: [{ artifact_id: 'map.main', kind: 'map', semantic_rev: 2, view_rev: 1 }],
          stored_session_id: 'stored-session'
        })
      }
    })
    expect(send).toHaveBeenNthCalledWith(2, { type: 'response.create' })
  })

  it('delegates visualize calls to the mute workbench agent', async () => {
    const request = vi.fn(async () => ({
      artifact: { artifact_id: 'map.main', semantic_rev: 3, payload: { nodes: [], edges: [] } }
    }))

    const send = vi.fn()

    await routeRealtimeServerEvent(
      {
        type: 'response.function_call_arguments.done',
        call_id: 'call-visualize',
        name: 'visualize',
        arguments: JSON.stringify({ prompt: 'Show voice and canvas as separate consumers.' })
      },
      { request, runtimeSessionId: 'runtime-session', send }
    )

    expect(request).toHaveBeenCalledWith('workbench.visualize', {
      session_id: 'runtime-session',
      prompt: 'Show voice and canvas as separate consumers.'
    })
    expect(JSON.parse(send.mock.calls[0][0].item.output).artifact.semantic_rev).toBe(3)
  })

  it('returns visualization failures to the voice agent instead of dropping the turn', async () => {
    const send = vi.fn()

    await expect(
      routeRealtimeServerEvent(
        {
          type: 'response.function_call_arguments.done',
          call_id: 'call-visualize',
          name: 'visualize',
          arguments: '{}'
        },
        {
          request: vi.fn(async () => {
            throw new Error('diagram JSON was invalid')
          }),
          runtimeSessionId: 'runtime-session',
          send
        }
      )
    ).resolves.toBeUndefined()

    expect(JSON.parse(send.mock.calls[0][0].item.output)).toEqual({
      error: 'diagram JSON was invalid'
    })
    expect(send).toHaveBeenNthCalledWith(2, { type: 'response.create' })
  })

  it('publishes completed user and assistant transcripts', async () => {
    const onTranscript = vi.fn()

    const deps = {
      request: vi.fn(),
      runtimeSessionId: 'runtime-session',
      send: vi.fn(),
      onTranscript
    }

    await routeRealtimeServerEvent(
      {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'user-1',
        transcript: 'What if the canvas owns layout?'
      },
      deps
    )
    await routeRealtimeServerEvent(
      {
        type: 'response.output_audio_transcript.done',
        item_id: 'assistant-1',
        transcript: 'Then ambient only writes meaning.'
      },
      deps
    )

    expect(onTranscript).toHaveBeenNthCalledWith(1, {
      id: 'user-1',
      role: 'user',
      text: 'What if the canvas owns layout?'
    })
    expect(onTranscript).toHaveBeenNthCalledWith(2, {
      id: 'assistant-1',
      role: 'assistant',
      text: 'Then ambient only writes meaning.'
    })
  })

  it('reports speaking and listening lifecycle from server events', async () => {
    const onStatus = vi.fn()

    const deps = {
      onStatus,
      request: vi.fn(),
      runtimeSessionId: 'runtime-session',
      send: vi.fn()
    }

    await routeRealtimeServerEvent({ type: 'response.created' }, deps)
    await routeRealtimeServerEvent({ type: 'response.done' }, deps)

    expect(onStatus).toHaveBeenNthCalledWith(1, 'speaking')
    expect(onStatus).toHaveBeenNthCalledWith(2, 'listening')
  })
})

describe('startRealtimeVoiceConnection', () => {
  /** Boot a connection over fake WebRTC and expose its data-channel traffic. */
  const connectHarness = async () => {
    const sent: string[] = []
    const listeners = new Map<string, (event: { data?: string }) => void>()

    const channel = {
      addEventListener: vi.fn((type: string, handler: (event: { data?: string }) => void) => {
        listeners.set(type, handler)
      }),
      close: vi.fn(),
      send: vi.fn((payload: string) => sent.push(payload))
    }

    const peer = {
      addTrack: vi.fn(),
      close: vi.fn(),
      createDataChannel: vi.fn(() => channel),
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' })),
      ontrack: null,
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined)
    }

    const track = { enabled: true, stop: vi.fn() }

    const connection = await startRealtimeVoiceConnection({
      audioFactory: () =>
        ({ autoplay: false, pause: vi.fn(), remove: vi.fn(), srcObject: null }) as never,
      fetchFn: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => 'answer-sdp'
      })) as never,
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } as never,
      peerConnectionFactory: () => peer as never,
      request: vi.fn(async () => ({
        client_secret: 'ek_short',
        model: 'gpt-realtime-2.1',
        voice: 'marin'
      })),
      runtimeSessionId: 'runtime-session'
    })

    return {
      connection,
      emit: (event: Record<string, unknown>) =>
        listeners.get('message')?.({ data: JSON.stringify(event) }),
      open: () => listeners.get('open')?.({}),
      sent,
      sentTypes: () => sent.map(payload => JSON.parse(payload).type as string)
    }
  }

  it('connects WebRTC with an ephemeral key and cleans up owned media', async () => {
    const sent: string[] = []
    const channelListeners = new Map<string, (event: { data?: string }) => void>()

    const channel = {
      addEventListener: vi.fn((type: string, handler: (event: { data?: string }) => void) => {
        channelListeners.set(type, handler)
      }),
      close: vi.fn(),
      send: vi.fn((payload: string) => sent.push(payload))
    }

    const peer = {
      addTrack: vi.fn(),
      close: vi.fn(),
      createDataChannel: vi.fn(() => channel),
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' })),
      ontrack: null as null | ((event: { streams: unknown[] }) => void),
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined)
    }

    const track = { enabled: true, stop: vi.fn() }
    const stream = { getTracks: () => [track] }
    const audio = { autoplay: false, pause: vi.fn(), remove: vi.fn(), srcObject: null as unknown }

    const request = vi.fn(async (method: string) => {
      expect(method).toBe('voice.realtime.token')

      return {
        client_secret: 'ek_short',
        expires_at: 1234,
        model: 'gpt-realtime-2.1',
        voice: 'marin'
      }
    })

    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'answer-sdp' }))

    const connection = await startRealtimeVoiceConnection({
      audioFactory: () => audio as never,
      fetchFn: fetchFn as never,
      mediaDevices: { getUserMedia: vi.fn(async () => stream) } as never,
      peerConnectionFactory: () => peer as never,
      request,
      runtimeSessionId: 'runtime-session'
    })

    expect(request).toHaveBeenCalledWith('voice.realtime.token', { session_id: 'runtime-session' })
    expect(peer.addTrack).toHaveBeenCalledWith(track, stream)
    expect(fetchFn).toHaveBeenCalledWith('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: 'offer-sdp',
      headers: {
        Authorization: 'Bearer ' + 'ek_short',
        'Content-Type': 'application/sdp'
      }
    })
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' })

    channelListeners.get('open')?.({})
    const sessionUpdate = JSON.parse(sent[0])

    expect(sessionUpdate).toMatchObject({
      type: 'session.update',
      session: { tool_choice: 'auto' }
    })
    expect(sessionUpdate.session.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'session_snapshot',
      'visualize'
    ])

    connection.updateWorkbenchContext('Nodes: GPT Realtime, Workbench canvas. Edge: voice sees canvas.')
    expect(JSON.parse(sent.at(-1) ?? '{}')).toMatchObject({
      type: 'session.update',
      session: {
        instructions: expect.stringContaining('Nodes: GPT Realtime, Workbench canvas')
      }
    })

    connection.setMuted(true)
    expect(track.enabled).toBe(false)
    connection.close()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(channel.close).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledOnce()
    expect(audio.pause).toHaveBeenCalledOnce()
    expect(audio.remove).toHaveBeenCalledOnce()
  })

  it('negotiates SDP against the host that issued the credential', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: unknown) => ({
      ok: true,
      status: 200,
      text: async () => 'answer-sdp'
    }))

    const channel = { addEventListener: vi.fn(), close: vi.fn(), send: vi.fn() }

    const peer = {
      addTrack: vi.fn(),
      close: vi.fn(),
      createDataChannel: vi.fn(() => channel),
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' })),
      ontrack: null,
      setLocalDescription: vi.fn(async () => undefined),
      setRemoteDescription: vi.fn(async () => undefined)
    }

    await startRealtimeVoiceConnection({
      audioFactory: () =>
        ({ autoplay: false, pause: vi.fn(), remove: vi.fn(), srcObject: null }) as never,
      fetchFn: fetchFn as never,
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ enabled: true, stop: vi.fn() }] }))
      } as never,
      peerConnectionFactory: () => peer as never,
      request: vi.fn(async () => ({
        client_secret: 'ek_azure',
        model: 'gpt-realtime-2.1',
        voice: 'marin',
        webrtc_url: 'https://victo-m40le98w-eastus2.openai.azure.com/openai/v1/realtime/calls'
      })),
      runtimeSessionId: 'runtime-session'
    })

    // An Azure-issued ephemeral secret is rejected at api.openai.com.
    expect(fetchFn.mock.calls[0][0]).toBe(
      'https://victo-m40le98w-eastus2.openai.azure.com/openai/v1/realtime/calls'
    )
  })

  it('does not open the microphone when credential minting fails', async () => {
    const getUserMedia = vi.fn()

    await expect(
      startRealtimeVoiceConnection({
        mediaDevices: { getUserMedia } as never,
        request: vi.fn(async () => {
          throw new Error('OpenAI key missing')
        }),
        runtimeSessionId: 'runtime-session'
      })
    ).rejects.toThrow('OpenAI key missing')

    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('keeps barge-in turn detection on every session update', async () => {
    const harness = await connectHarness()

    harness.open()
    const initial = JSON.parse(harness.sent[0])

    expect(initial.session.audio.input.turn_detection).toEqual({
      type: 'semantic_vad',
      eagerness: 'auto',
      create_response: true,
      interrupt_response: true
    })

    // A context update must not silently drop VAD if the API replaces rather
    // than merges the session object.
    harness.connection.updateWorkbenchContext('Nodes: voice, canvas.')
    expect(JSON.parse(harness.sent.at(-1) ?? '{}').session.audio.input.turn_detection).toEqual(
      initial.session.audio.input.turn_detection
    )
  })

  it('clears buffered assistant audio on barge-in, but only while speaking', async () => {
    const harness = await connectHarness()
    harness.open()

    // Not speaking yet: clearing an empty buffer is an API error.
    harness.emit({ type: 'input_audio_buffer.speech_started' })
    expect(harness.sentTypes()).not.toContain('output_audio_buffer.clear')

    harness.emit({ type: 'output_audio_buffer.started' })
    harness.emit({ type: 'input_audio_buffer.speech_started' })
    expect(harness.sentTypes()).toContain('output_audio_buffer.clear')

    // A second barge-in with an already-flushed buffer must not re-clear.
    const clears = harness.sentTypes().filter(type => type === 'output_audio_buffer.clear').length
    harness.emit({ type: 'input_audio_buffer.speech_started' })
    expect(
      harness.sentTypes().filter(type => type === 'output_audio_buffer.clear')
    ).toHaveLength(clears)
  })

  it('cancels generation and flushes audio on a manual stopTurn', async () => {
    const harness = await connectHarness()
    harness.open()
    harness.emit({ type: 'output_audio_buffer.started' })

    harness.connection.stopTurn()

    expect(harness.sentTypes()).toContain('response.cancel')
    expect(harness.sentTypes()).toContain('output_audio_buffer.clear')
  })
})
