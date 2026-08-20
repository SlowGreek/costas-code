import { describe, expect, it, vi } from 'vitest'

import {
  boundWorkbenchContext,
  createPendingTranscriptionTracker,
  MAX_WORKBENCH_CONTEXT_CHARS,
  type RealtimeTranscript,
  routeRealtimeServerEvent,
  startRealtimeVoiceConnection,
  voiceToolLane
} from './realtime-voice'

describe('boundWorkbenchContext', () => {
  const marker = 'Current canvas state (authoritative): '

  it('preserves the JSON boundary when the semantic prefix alone exceeds budget', () => {
    const result = boundWorkbenchContext(`${'x'.repeat(20_000)}${marker}{"kind":"map"}`)

    expect(result.length).toBeLessThanOrEqual(MAX_WORKBENCH_CONTEXT_CHARS)
    expect(result).toContain(marker)
    expect(() => JSON.parse(result.slice(result.indexOf(marker) + marker.length))).not.toThrow()
  })

  it('is not confused by the boundary text inside a node label', () => {
    const state = {
      kind: 'map',
      nodes: Array.from({ length: 40 }, (_, index) => ({
        id: `n-${index}-${'i'.repeat(120)}`,
        label: `${index === 20 ? marker : ''}${'L'.repeat(190)}`
      })),
      edges: Array.from({ length: 80 }, (_, index) => ({
        id: `e-${index}-${'e'.repeat(120)}`,
        from: `n-${index % 40}-${'i'.repeat(120)}`,
        to: `n-${(index + 1) % 40}-${'i'.repeat(120)}`,
        label: 'R'.repeat(190)
      }))
    }

    const result = boundWorkbenchContext(`Canvas changed. ${marker}${JSON.stringify(state)}`)

    const compacted = JSON.parse(result.slice(result.indexOf(marker) + marker.length)) as {
      context_truncated?: { nodes_total?: number }
    }

    expect(result.length).toBeLessThanOrEqual(MAX_WORKBENCH_CONTEXT_CHARS)
    expect(compacted.context_truncated?.nodes_total).toBe(40)
  })
})

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

describe('voiceToolLane', () => {
  it('classifies reads, gestures, edits, and slow detached work', () => {
    expect(voiceToolLane({ name: 'session_snapshot' } as never)).toBe('read')
    expect(voiceToolLane({ name: 'web_search' } as never)).toBe('read')
    expect(voiceToolLane({ name: 'focus' } as never)).toBe('gesture')
    expect(voiceToolLane({ name: 'rename' } as never)).toBe('edit')
    expect(voiceToolLane({ name: 'visualize' } as never)).toBe('slow')
    expect(voiceToolLane({ name: 'unknown' } as never)).toBe('serial')
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
  it('routes assistant transcript deltas before clearing narration focus at response end', async () => {
    const events: string[] = []

    const deps = {
      onAssistantResponseDone: () => events.push('done'),
      onAssistantTranscriptDelta: (delta: string) => events.push(delta),
      request: vi.fn(),
      runtimeSessionId: 'runtime-session',
      send: vi.fn()
    }

    await routeRealtimeServerEvent(
      { type: 'response.output_audio_transcript.delta', delta: 'API ' },
      deps
    )
    await routeRealtimeServerEvent(
      { type: 'response.output_audio_transcript.delta', delta: 'Gateway' },
      deps
    )
    await routeRealtimeServerEvent({ type: 'response.done' }, deps)

    expect(events).toEqual(['API ', 'Gateway', 'done'])
    expect(deps.request).not.toHaveBeenCalled()
    expect(deps.send).not.toHaveBeenCalled()
  })

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

  it('delegates visualize calls to the mute workbench agent without blocking', async () => {
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
    // The redraw takes ~9s in production. The model is told it STARTED, not
    // that it finished — waiting for the artifact froze the conversation.
    expect(JSON.parse(send.mock.calls[0][0].item.output)).toEqual({ status: 'drawing' })
  })

  it('does not fail the turn when a redraw fails after the model moved on', async () => {
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

    // The failure arrives after the turn is already over, so it cannot be
    // reported as a tool error. It surfaces through the canvas instead: the
    // drawing indicator clears and the artifact simply does not change.
    expect(JSON.parse(send.mock.calls[0][0].item.output)).toEqual({ status: 'drawing' })
    expect(send).toHaveBeenNthCalledWith(2, { type: 'response.create' })
  })

  it('routes current-information searches through the configured backend provider', async () => {
    const request = vi.fn(async () => ({
      success: true,
      data: { web: [{ title: 'Current', url: 'https://example.com', description: 'Live result' }] }
    }))

    const send = vi.fn()

    await routeRealtimeServerEvent(
      {
        type: 'response.function_call_arguments.done',
        call_id: 'call-search',
        name: 'web_search',
        arguments: JSON.stringify({ query: 'latest realtime api', limit: 99 })
      },
      { request, runtimeSessionId: 'runtime-session', send }
    )

    expect(request).toHaveBeenCalledWith('voice.realtime.web_search', {
      session_id: 'runtime-session',
      query: 'latest realtime api',
      limit: 5
    })
    expect(JSON.parse(send.mock.calls[0][0].item.output).data.web[0].title).toBe('Current')
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
  const connectHarness = async (
    tokenOverrides: Record<string, unknown> = {},
    onTranscript?: (entry: RealtimeTranscript) => void,
    requestOverride?: (method: string, params: Record<string, unknown>) => Promise<unknown>
  ) => {
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
      onTranscript,
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method !== 'voice.realtime.token' && requestOverride) {
          return requestOverride(method, params)
        }

        return {
          client_secret: 'ek_short',
          model: 'gpt-realtime-2.1',
          voice: 'marin',
          ...tokenOverrides
        }
      }),
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

  it('tags settled transcripts with the token connection lease', async () => {
    const onTranscript = vi.fn()
    const harness = await connectHarness({ connection_id: 'connection-a' }, onTranscript)

    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-a' })
    harness.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-a',
      transcript: 'Keep ownership with this connection.'
    })

    await vi.waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith({
        connectionId: 'connection-a',
        id: 'user-a',
        role: 'user',
        semanticTurnId: 'voice-connection-a-turn-1',
        text: 'Keep ownership with this connection.'
      })
    )
  })

  it('keeps voice as the redraw owner even for a legacy watcher token', async () => {
    // Older backends/configs can still advertise watcher ownership. The client
    // must fail toward the deliberate voice-owned path rather than silently
    // removing visualize and letting a transcript observer decide when to draw.
    const harness = await connectHarness({
      workbench_watcher: { active: true, owns_redraws: true, pipeline: 'direct' }
    })

    harness.open()

    const update = JSON.parse(harness.sent[0]) as {
      session: { instructions: string; tools: { description: string; name: string }[] }
    }

    const names = update.session.tools.map(tool => tool.name)

    expect(names).toContain('visualize')
    expect(names).toContain('focus')
    expect(names).toContain('go_back')
    expect(update.session.tools.find(tool => tool.name === 'visualize')?.description).toMatch(
      /edits? in place/i
    )
    expect(update.session.instructions).toMatch(/you decide when the drawing should change/i)
    expect(update.session.instructions).not.toMatch(/background canvas worker owns every full redraw/i)
  })

  it('keeps visualize when the watcher is shadow-only', async () => {
    const harness = await connectHarness({
      workbench_watcher: { active: false, owns_redraws: false, pipeline: 'direct' }
    })

    harness.open()
    const update = JSON.parse(harness.sent[0]) as { session: { tools: { name: string }[] } }

    expect(update.session.tools.map(tool => tool.name)).toContain('visualize')
  })

  it('exposes live web search only when the backend advertises it', async () => {
    const available = await connectHarness({ voice_capabilities: { web_search: true } })

    available.open()

    const enabledUpdate = JSON.parse(available.sent[0]) as {
      session: { instructions: string; tools: { name: string }[] }
    }

    expect(enabledUpdate.session.tools.map(tool => tool.name)).toContain('web_search')
    expect(enabledUpdate.session.instructions).toMatch(/current information/i)

    const unavailable = await connectHarness({ voice_capabilities: { web_search: false } })

    unavailable.open()
    const disabledUpdate = JSON.parse(unavailable.sent[0]) as { session: { tools: { name: string }[] } }
    expect(disabledUpdate.session.tools.map(tool => tool.name)).not.toContain('web_search')
  })

  it('batches every function call in a provider response behind one continuation', async () => {
    const harness = await connectHarness()

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-snapshot-1',
      name: 'session_snapshot',
      arguments: '{}'
    })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-snapshot-2',
      name: 'session_snapshot',
      arguments: '{}'
    })
    await Promise.resolve()

    expect(harness.sentTypes()).not.toContain('conversation.item.create')
    expect(harness.sentTypes()).not.toContain('response.create')

    harness.emit({ type: 'response.done', response: { id: 'response-1' } })
    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'conversation.item.create')).toHaveLength(2)
    )
    expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(1)
  })

  it('does not resurrect an interrupted turn when a slow tool finishes late', async () => {
    let finishSearch!: (value: unknown) => void

    const search = new Promise<unknown>(resolve => {
      finishSearch = resolve
    })

    const requestOverride = vi.fn(async (method: string) => {
      expect(method).toBe('voice.realtime.web_search')

      return search
    })

    const harness = await connectHarness(
      { voice_capabilities: { web_search: true } },
      undefined,
      requestOverride
    )

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-search',
      name: 'web_search',
      arguments: JSON.stringify({ query: 'latest realtime changes' })
    })
    harness.emit({ type: 'response.done', response: { id: 'response-1' } })
    await vi.waitFor(() => expect(requestOverride).toHaveBeenCalledOnce())

    harness.emit({ type: 'input_audio_buffer.speech_started' })
    finishSearch({ success: true })
    await Promise.resolve()
    await Promise.resolve()

    const output = harness.sent
      .map(raw => JSON.parse(raw) as { item?: { output?: string }; type: string })
      .find(event => event.type === 'conversation.item.create')

    expect(JSON.parse(output?.item?.output ?? '{}')).toEqual({ cancelled: true })
    expect(harness.sentTypes()).not.toContain('response.create')
  })

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
      'visualize',
      // Surgical tools: one thing, instantly, with no diagrammer round trip.
      'focus',
      'go_back',
      'rename',
      'connect',
      'disconnect',
      'remove'
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

  it('appends context WITHOUT making the model speak', async () => {
    // The whole idea rests on this: `conversation.item.create` mutates context
    // and `response.create` runs the model, and they are independent. If an
    // append ever triggered generation, a background worker keeping the model
    // current would interrupt the user mid-sentence on every canvas change.
    const harness = await connectHarness()

    harness.open()
    harness.sent.length = 0

    harness.connection.appendContext('You added Memory and connected it to Retrieval.')

    const sent = harness.sent.map(raw => JSON.parse(raw) as { item?: { role?: string }; type: string })

    expect(sent.some(e => e.type === 'conversation.item.create')).toBe(true)
    expect(sent.some(e => e.type === 'response.create')).toBe(false)
    expect(sent.find(e => e.type === 'conversation.item.create')?.item?.role).toBe('system')
  })

  it('does not truncate an authoritative canvas snapshot mid-object', async () => {
    // Context sync appends a semantic event PLUS the current authoritative
    // snapshot. On a real graph that is routinely >500 characters. The old
    // cap sliced it mid-JSON, leaving the voice model with an unparsable/stale
    // world view exactly when the canvas became interesting.
    const harness = await connectHarness()

    harness.open()
    harness.sent.length = 0

    const nodes = Array.from({ length: 40 }, (_, index) => ({
      id: `node-${index}-${'i'.repeat(118)}`,
      label: `Node ${index} ${'L'.repeat(190)}`,
      location: index % 2 ? 'far right' : 'upper left'
    }))

    const fact = `Canvas changed. Current canvas state (authoritative): ${JSON.stringify({
      edges: Array.from({ length: 80 }, (_, index) => ({
        from: nodes[index % 40].id,
        id: `edge-${index}-${'e'.repeat(118)}`,
        label: `Relationship ${index} ${'R'.repeat(180)}`,
        to: nodes[(index + 1) % 40].id
      })),
      kind: 'map',
      nodes,
      revision: 9
    })}`

    harness.connection.appendContext(fact)

    const event = harness.sent
      .map(raw => JSON.parse(raw) as { item?: { content?: { text?: string }[] }; type: string })
      .find(item => item.type === 'conversation.item.create')

    const received = event?.item?.content?.[0]?.text ?? ''

    expect(fact.length).toBeGreaterThan(MAX_WORKBENCH_CONTEXT_CHARS)
    expect(received.length).toBeLessThanOrEqual(MAX_WORKBENCH_CONTEXT_CHARS)
    const marker = 'Current canvas state (authoritative): '

    const compacted = JSON.parse(received.slice(received.lastIndexOf(marker) + marker.length)) as {
      context_truncated: {
        edges_shown: number
        edges_total: number
        nodes_shown: number
        nodes_total: number
      }
      nodes: { id: string }[]
    }

    expect(compacted.context_truncated.nodes_total).toBe(40)
    expect(compacted.context_truncated.edges_total).toBe(80)
    expect(compacted.context_truncated.nodes_shown).toBe(compacted.nodes.length)
    expect(compacted.context_truncated.edges_shown).toBeLessThan(80)
    expect(compacted.nodes[0].id).toContain('node-0')
  })

  it('ignores an empty append rather than sending a blank turn', async () => {
    const harness = await connectHarness()

    harness.open()
    harness.sent.length = 0

    harness.connection.appendContext('   ')

    expect(harness.sent).toHaveLength(0)
  })

  it('keeps barge-in turn detection on every session update', async () => {
    const harness = await connectHarness()

    harness.open()
    const initial = JSON.parse(harness.sent[0])

    expect(initial.session.audio.input.turn_detection).toEqual(
      expect.objectContaining({
        type: 'semantic_vad',
        create_response: true,
        interrupt_response: true
      })
    )

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
