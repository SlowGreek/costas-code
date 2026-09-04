import { describe, expect, it, vi } from 'vitest'

import {
  boundWorkbenchContext,
  createPendingTranscriptionTracker,
  executeRealtimeVoiceTool,
  MAX_WORKBENCH_CONTEXT_CHARS,
  type RealtimeCameraCommand,
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

  it('retires lost transcription state after the fallback timeout', async () => {
    vi.useFakeTimers()
    const tracker = createPendingTranscriptionTracker()
    const first = vi.fn()
    const later = vi.fn()

    tracker.markPending()
    void tracker.awaitSettled().then(first)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(first).toHaveBeenCalledOnce()

    void tracker.awaitSettled().then(later)
    await Promise.resolve()
    expect(later).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('does not let a late retired transcription settle a newer utterance', async () => {
    vi.useFakeTimers()
    const tracker = createPendingTranscriptionTracker()
    const retired = vi.fn()
    const current = vi.fn()

    tracker.markPending('utterance-a')
    void tracker.awaitSettled().then(retired)
    await vi.advanceTimersByTimeAsync(3_990)

    tracker.markPending('utterance-b')
    await vi.advanceTimersByTimeAsync(10)
    expect(retired).toHaveBeenCalledOnce()

    tracker.markPending('utterance-c')
    void tracker.awaitSettled().then(current)
    tracker.settle('utterance-b')
    await Promise.resolve()
    expect(current).not.toHaveBeenCalled()

    tracker.settle('utterance-c')
    await Promise.resolve()
    expect(current).toHaveBeenCalledOnce()
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

describe('finish_turn', () => {
  it('accepts an explicit complete declaration without touching the gateway', async () => {
    const request = vi.fn()

    await expect(
      executeRealtimeVoiceTool(
        {
          arguments: JSON.stringify({ status: 'complete', reason: 'The requested comparison is finished.' }),
          callId: 'call-finish',
          name: 'finish_turn',
          responseId: 'response-2'
        },
        { request, runtimeSessionId: 'runtime-session' }
      )
    ).resolves.toEqual({ reason: 'The requested comparison is finished.', status: 'complete' })
    expect(request).not.toHaveBeenCalled()
  })

  it('accepts deferred work only when a background continuation is named', async () => {
    await expect(
      executeRealtimeVoiceTool(
        {
          arguments: JSON.stringify({
            status: 'deferred',
            reason: 'The delegated evidence collection will resume this goal when ready.'
          }),
          callId: 'call-deferred',
          name: 'finish_turn',
          responseId: 'response-2'
        },
        { request: vi.fn(), runtimeSessionId: 'runtime-session' }
      )
    ).resolves.toEqual({
      reason: 'The delegated evidence collection will resume this goal when ready.',
      status: 'deferred'
    })
  })

  it('requires a reason when declaring the turn blocked', async () => {
    await expect(
      executeRealtimeVoiceTool(
        {
          arguments: JSON.stringify({ status: 'blocked' }),
          callId: 'call-finish',
          name: 'finish_turn',
          responseId: 'response-2'
        },
        { request: vi.fn(), runtimeSessionId: 'runtime-session' }
      )
    ).resolves.toEqual({ error: 'finish_turn blocked requires a reason' })
  })
})

describe('voiceToolLane', () => {
  it('classifies reads, gestures, edits, terminal declarations, and slow detached work', () => {
    expect(voiceToolLane({ name: 'finish_turn' } as never)).toBe('terminal')
    expect(voiceToolLane({ name: 'session_snapshot' } as never)).toBe('read')
    expect(voiceToolLane({ name: 'web_search' } as never)).toBe('read')
    expect(voiceToolLane({ name: 'research_status' } as never)).toBe('read')
    expect(voiceToolLane({ name: 'research_search' } as never)).toBe('read')
    expect(voiceToolLane({ name: 'research_read' } as never)).toBe('read')
    expect(voiceToolLane({ name: 'focus' } as never)).toBe('gesture')
    expect(voiceToolLane({ name: 'present_step' } as never)).toBe('gesture')
    expect(voiceToolLane({ name: 'add_node' } as never)).toBe('presentation')
    expect(voiceToolLane({ name: 'rename' } as never)).toBe('edit')
    expect(voiceToolLane({ name: 'visualize' } as never)).toBe('slow')
    expect(voiceToolLane({ name: 'speed_draw' } as never)).toBe('slow')
    expect(voiceToolLane({ name: 'delegate_research' } as never)).toBe('slow')
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
    const assistantAudioStarted = vi.fn()
    const assistantAudioEnded = vi.fn()

    const shared = deps({
      onAssistantAudioEnded,
      onAssistantAudioStarted,
      turnController: {
        assistantAudioEnded,
        assistantAudioStarted
      } as never
    })

    await routeRealtimeServerEvent({ type: 'output_audio_buffer.started' }, shared)
    expect(onAssistantAudioStarted).toHaveBeenCalled()
    expect(assistantAudioStarted).toHaveBeenCalled()

    await routeRealtimeServerEvent({ type: 'output_audio_buffer.stopped' }, shared)
    expect(onAssistantAudioEnded).toHaveBeenCalled()
    expect(assistantAudioEnded).toHaveBeenCalled()
  })

  it('does not treat response generation completion as audio playback completion', async () => {
    const onAssistantAudioEnded = vi.fn()

    await routeRealtimeServerEvent({ type: 'response.done' }, deps({ onAssistantAudioEnded }))

    expect(onAssistantAudioEnded).not.toHaveBeenCalled()
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

    await routeRealtimeServerEvent({ type: 'input_audio_buffer.committed', item_id: 'item-1' }, deps)
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

    await routeRealtimeServerEvent({ type: 'input_audio_buffer.committed', item_id: 'item-1' }, deps)
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

  it('routes transcription identities without letting late events settle newer speech', async () => {
    vi.useFakeTimers()
    const pendingTranscription = createPendingTranscriptionTracker()

    const deps = {
      pendingTranscription,
      request: vi.fn(),
      runtimeSessionId: 'runtime-session',
      send: vi.fn()
    }

    const retired = vi.fn()
    const current = vi.fn()

    await routeRealtimeServerEvent(
      { type: 'input_audio_buffer.committed', item_id: 'utterance-a' },
      deps
    )
    void pendingTranscription.awaitSettled().then(retired)
    await vi.advanceTimersByTimeAsync(3_990)
    await routeRealtimeServerEvent(
      { type: 'input_audio_buffer.committed', item_id: 'utterance-b' },
      deps
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(retired).toHaveBeenCalledOnce()

    await routeRealtimeServerEvent(
      { type: 'input_audio_buffer.committed', item_id: 'utterance-c' },
      deps
    )
    void pendingTranscription.awaitSettled().then(current)
    await routeRealtimeServerEvent(
      {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'utterance-b',
        transcript: 'Late prior speech.'
      },
      deps
    )
    await Promise.resolve()
    expect(current).not.toHaveBeenCalled()

    await routeRealtimeServerEvent(
      {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'utterance-c',
        transcript: 'Current speech.'
      },
      deps
    )
    await Promise.resolve()
    expect(current).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('atomically focuses and closely frames one presentation subject', async () => {
    const order: string[] = []

    const request = vi.fn(async (method: string) => {
      order.push(method)

      return { focused: true }
    })

    const onCameraCommand = vi.fn(() => {
      order.push('camera')

      return true
    })

    const output = await executeRealtimeVoiceTool(
      {
        arguments: JSON.stringify({
          subject_id: 'planner',
          framing: 'close',
          anchor: 'left',
          transition: 'smooth'
        }),
        callId: 'call-present',
        name: 'present_step',
        responseId: 'response-1'
      },
      { onCameraCommand, request, runtimeSessionId: 'runtime-session' }
    )

    expect(order).toEqual(['workbench.focus', 'camera'])
    expect(request).toHaveBeenCalledWith('workbench.focus', {
      node_id: 'planner',
      session_id: 'runtime-session'
    })
    expect(onCameraCommand).toHaveBeenCalledWith({
      anchor: 'left',
      kind: 'zoom_to',
      nodeId: 'planner',
      transition: 'smooth',
      zoom: 2
    })
    expect(output).toMatchObject({
      next_response_guidance: 'Briefly explain planner, then choose the next useful action without waiting for the user.',
      status: 'presented',
      subject_id: 'planner'
    })
  })

  it('frames a subject with its related context in one presentation beat', async () => {
    const request = vi.fn(async () => ({ focused: true }))
    const onCameraCommand = vi.fn(() => true)

    await executeRealtimeVoiceTool(
      {
        arguments: JSON.stringify({
          subject_id: 'executor',
          context_ids: ['planner', 'reviser'],
          framing: 'context',
          transition: 'quick'
        }),
        callId: 'call-present-context',
        name: 'present_step',
        responseId: 'response-1'
      },
      { onCameraCommand, request, runtimeSessionId: 'runtime-session' }
    )

    expect(onCameraCommand).toHaveBeenCalledWith({
      anchor: 'center',
      kind: 'frame_nodes',
      nodeIds: ['executor', 'planner', 'reviser'],
      padding: 'normal',
      transition: 'quick'
    })
  })

  it('creates, connects, focuses, and frames one graph subject in order', async () => {
    const order: string[] = []

    const request = vi.fn(async (method: string) => {
      order.push(method)

      return { ok: true }
    })

    const onCameraCommand = vi.fn(() => {
      order.push('camera')

      return true
    })

    const output = await executeRealtimeVoiceTool(
      {
        arguments: JSON.stringify({
          subject_id: 'executor',
          add: { label: 'Executor', kind: 'agent' },
          connect_from: 'planner',
          edge_label: 'plan',
          framing: 'close'
        }),
        callId: 'call-build-present',
        name: 'present_step',
        responseId: 'response-1'
      },
      { onCameraCommand, request, runtimeSessionId: 'runtime-session' }
    )

    expect(order).toEqual(['workbench.edit', 'workbench.edit', 'workbench.focus', 'camera'])
    expect(request).toHaveBeenNthCalledWith(1, 'workbench.edit', {
      session_id: 'runtime-session',
      edit: { id: 'executor', kind: 'agent', label: 'Executor', op: 'add_node' }
    })
    expect(request).toHaveBeenNthCalledWith(2, 'workbench.edit', {
      session_id: 'runtime-session',
      edit: { from_id: 'planner', label: 'plan', op: 'connect', to_id: 'executor' }
    })
    expect(output).toMatchObject({ status: 'presented', subject_id: 'executor' })
  })

  it('reports committed graph work honestly when camera application fails', async () => {
    const request = vi.fn(async (method: string) => ({ method, ok: true }))

    const output = await executeRealtimeVoiceTool(
      {
        arguments: JSON.stringify({
          subject_id: 'executor',
          add: { label: 'Executor' },
          connect_from: 'planner'
        }),
        callId: 'call-partial-present',
        name: 'present_step',
        responseId: 'response-1'
      },
      { onCameraCommand: vi.fn(() => false), request, runtimeSessionId: 'runtime-session' }
    )

    expect(output).toMatchObject({
      error: 'The presentation subject is not available in the current canvas layout',
      committed: {
        add: { method: 'workbench.edit', ok: true },
        connect: { method: 'workbench.edit', ok: true },
        focus: { method: 'workbench.focus', ok: true }
      },
      status: 'partial',
      subject_id: 'executor'
    })
  })

  it('pans while keeping the presentation subject highlighted', async () => {
    const request = vi.fn(async () => ({ focused: true }))
    const onCameraCommand = vi.fn(() => true)

    await executeRealtimeVoiceTool(
      {
        arguments: JSON.stringify({
          subject_id: 'executor',
          pan: { direction: 'right', amount: 'small' },
          transition: 'smooth'
        }),
        callId: 'call-present-pan',
        name: 'present_step',
        responseId: 'response-1'
      },
      { onCameraCommand, request, runtimeSessionId: 'runtime-session' }
    )

    expect(request).toHaveBeenCalledWith('workbench.focus', {
      node_id: 'executor',
      session_id: 'runtime-session'
    })
    expect(onCameraCommand).toHaveBeenCalledWith({
      amount: 'small',
      direction: 'right',
      kind: 'pan_view',
      requireNodeId: 'executor',
      transition: 'smooth'
    })
  })

  it('rejects a presentation beat with no stable subject id', async () => {
    const request = vi.fn()

    await expect(
      executeRealtimeVoiceTool(
        {
          arguments: JSON.stringify({ framing: 'close' }),
          callId: 'call-present-invalid',
          name: 'present_step',
          responseId: 'response-1'
        },
        { onCameraCommand: vi.fn(), request, runtimeSessionId: 'runtime-session' }
      )
    ).resolves.toEqual({ error: 'present_step requires a subject_id' })
    expect(request).not.toHaveBeenCalled()
  })

  it('bridges session_snapshot function calls to the Hermes gateway', async () => {
    const request = vi.fn(async () => ({
      artifacts: [{ artifact_id: 'map.main', kind: 'map', semantic_rev: 2, view_rev: 1 }],
      stored_session_id: 'stored-session'
    }))

    const output = await executeRealtimeVoiceTool(
      {
        arguments: '{}',
        callId: 'call-1',
        name: 'session_snapshot',
        responseId: 'response-1'
      },
      {
        request,
        runtimeSessionId: 'runtime-session'
      }
    )

    expect(request).toHaveBeenCalledWith('artifact.list', { session_id: 'runtime-session' })
    expect(output).toEqual({
      artifacts: [{ artifact_id: 'map.main', kind: 'map', semantic_rev: 2, view_rev: 1 }],
      stored_session_id: 'stored-session'
    })
  })

  it('delegates visualize calls to the mute workbench agent without blocking', async () => {
    const request = vi.fn(async () => ({
      artifact: { artifact_id: 'map.main', semantic_rev: 3, payload: { nodes: [], edges: [] } }
    }))

    const output = await executeRealtimeVoiceTool(
      {
        arguments: JSON.stringify({ prompt: 'Show voice and canvas as separate consumers.' }),
        callId: 'call-visualize',
        name: 'visualize',
        responseId: 'response-1'
      },
      { request, runtimeSessionId: 'runtime-session' }
    )

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.visualize', {
        session_id: 'runtime-session',
        prompt: 'Show voice and canvas as separate consumers.'
      })
    )
    // The redraw takes ~9s in production. The model is told it STARTED, not
    // that it finished — waiting for the artifact froze the conversation.
    expect(output).toEqual({ status: 'drawing' })
  })

  it('does not fail the turn when a redraw fails after the model moved on', async () => {
    const output = await executeRealtimeVoiceTool(
        {
          arguments: '{}',
          callId: 'call-visualize',
          name: 'visualize',
          responseId: 'response-1'
        },
        {
          request: vi.fn(async () => {
            throw new Error('diagram JSON was invalid')
          }),
          runtimeSessionId: 'runtime-session'
        }
      )

    // The failure arrives after the turn is already over, so it cannot be
    // reported as a tool error. It surfaces through the canvas instead: the
    // drawing indicator clears and the artifact simply does not change.
    expect(output).toEqual({ status: 'drawing' })
  })

  it('routes current-information searches through the configured backend provider', async () => {
    const request = vi.fn(async () => ({
      success: true,
      data: { web: [{ title: 'Current', url: 'https://example.com', description: 'Live result' }] }
    }))

    const output = await executeRealtimeVoiceTool(
      {
        arguments: JSON.stringify({ query: 'latest realtime api', limit: 99 }),
        callId: 'call-search',
        name: 'web_search',
        responseId: 'response-1'
      },
      { request, runtimeSessionId: 'runtime-session' }
    )

    expect(request).toHaveBeenCalledWith('voice.realtime.web_search', {
      session_id: 'runtime-session',
      query: 'latest realtime api',
      limit: 5
    })
    expect((output as { data: { web: { title: string }[] } }).data.web[0].title).toBe('Current')
  })

  it('dispatches substantial research silently and returns its durable artifact handle', async () => {
    const beforeToolCall = vi.fn(async () => undefined)
    const onResearchDispatched = vi.fn()

    const request = vi.fn(async () => ({
      status: 'dispatched',
      mission_id: 'mission_test',
      artifact_id: 'research_abc123def456',
      delegation_id: 'deleg_123'
    }))

    const output = await executeRealtimeVoiceTool(
      {
        arguments: JSON.stringify({ query: 'Trace Claude Code architecture with citations' }),
        callId: 'call-research',
        name: 'delegate_research',
        responseId: 'response-1'
      },
      {
        beforeToolCall,
        createMissionId: () => 'mission_test',
        onResearchDispatched,
        request,
        runtimeSessionId: 'runtime-session'
      }
    )

    expect(beforeToolCall).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith('voice.realtime.delegate_research', {
      session_id: 'runtime-session',
      mission_id: 'mission_test',
      query: 'Trace Claude Code architecture with citations'
    })
    expect(onResearchDispatched).toHaveBeenCalledWith({
      artifactId: 'research_abc123def456',
      delegationId: 'deleg_123',
      label: 'Trace Claude Code architecture with citations',
      missionId: 'mission_test',
      runtimeSessionId: 'runtime-session'
    })
    expect(output).toMatchObject({ status: 'dispatched', artifact_id: 'research_abc123def456' })
  })

  it('routes bounded research status, search, and read calls', async () => {
    const request = vi.fn(async (method: string) => ({ method }))
    const base = { callId: 'call-research', responseId: 'response-1' }

    await executeRealtimeVoiceTool(
      { ...base, name: 'research_status', arguments: '{"artifact_id":"research_abc123def456"}' },
      { request, runtimeSessionId: 'runtime-session' }
    )
    await executeRealtimeVoiceTool(
      {
        ...base,
        name: 'research_search',
        arguments: '{"artifact_id":"research_abc123def456","query":"orchestrator"}'
      },
      { request, runtimeSessionId: 'runtime-session' }
    )
    await executeRealtimeVoiceTool(
      {
        ...base,
        name: 'research_read',
        arguments: '{"artifact_id":"research_abc123def456","start_line":2,"line_count":999}'
      },
      { request, runtimeSessionId: 'runtime-session' }
    )

    expect(request).toHaveBeenNthCalledWith(1, 'voice.realtime.research_status', {
      session_id: 'runtime-session',
      artifact_id: 'research_abc123def456'
    })
    expect(request).toHaveBeenNthCalledWith(2, 'voice.realtime.research_search', {
      session_id: 'runtime-session',
      artifact_id: 'research_abc123def456',
      query: 'orchestrator'
    })
    expect(request).toHaveBeenNthCalledWith(3, 'voice.realtime.research_read', {
      session_id: 'runtime-session',
      artifact_id: 'research_abc123def456',
      start_line: 2,
      line_count: 100
    })
  })

  it('can recover the latest research handle after a voice reconnect', async () => {
    const request = vi.fn(async () => ({
      status: 'ready',
      artifact_id: 'research_abc123def456'
    }))

    await executeRealtimeVoiceTool(
      {
        callId: 'call-status',
        responseId: 'response-1',
        name: 'research_status',
        arguments: '{}'
      },
      { request, runtimeSessionId: 'runtime-session' }
    )

    expect(request).toHaveBeenCalledWith('voice.realtime.research_status', {
      session_id: 'runtime-session'
    })
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

  it('records the assistant transcript as the Stop checkpoint candidate', async () => {
    const assistantTranscriptDone = vi.fn()

    await routeRealtimeServerEvent(
      {
        type: 'response.output_audio_transcript.done',
        item_id: 'assistant-1',
        response_id: 'response-1',
        transcript: 'Candidate answer.'
      },
      {
        request: vi.fn(),
        runtimeSessionId: 'runtime-session',
        send: vi.fn(),
        turnController: {
          assistantTranscriptDone,
          turnIdForResponse: vi.fn(() => 'voice-turn-1')
        } as never
      }
    )

    expect(assistantTranscriptDone).toHaveBeenCalledWith('response-1', 'Candidate answer.')
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

  it('reports provider, speech, and playback boundaries for mission resumption', async () => {
    const callbacks = {
      onAssistantAudioEnded: vi.fn(),
      onAssistantAudioStarted: vi.fn(),
      onProviderResponseEnded: vi.fn(),
      onProviderResponseStarted: vi.fn(),
      onUserSpeechEnded: vi.fn(),
      onUserSpeechStarted: vi.fn()
    }

    const deps = {
      ...callbacks,
      request: vi.fn(),
      runtimeSessionId: 'runtime-session',
      send: vi.fn()
    }

    await routeRealtimeServerEvent({ type: 'response.created', response: { id: 'r1' } }, deps)
    await routeRealtimeServerEvent({ type: 'output_audio_buffer.started' }, deps)
    await routeRealtimeServerEvent({ type: 'output_audio_buffer.stopped' }, deps)
    await routeRealtimeServerEvent({ type: 'input_audio_buffer.speech_started' }, deps)
    await routeRealtimeServerEvent({ type: 'input_audio_buffer.speech_stopped' }, deps)
    await routeRealtimeServerEvent(
      { type: 'response.done', response: { id: 'r1', status: 'completed' } },
      deps
    )

    expect(callbacks.onProviderResponseStarted).toHaveBeenCalledOnce()
    expect(callbacks.onAssistantAudioStarted).toHaveBeenCalledOnce()
    expect(callbacks.onAssistantAudioEnded).toHaveBeenCalledOnce()
    expect(callbacks.onUserSpeechStarted).toHaveBeenCalledOnce()
    expect(callbacks.onUserSpeechEnded).toHaveBeenCalledOnce()
    expect(callbacks.onProviderResponseEnded).toHaveBeenCalledWith('completed', false)
  })
})

describe('startRealtimeVoiceConnection', () => {
  /** Boot a connection over fake WebRTC and expose its data-channel traffic. */
  const connectHarness = async (
    tokenOverrides: Record<string, unknown> = {},
    onTranscript?: (entry: RealtimeTranscript) => void,
    requestOverride?: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    onConnectionClosed?: () => void,
    onCameraCommand?: (command: RealtimeCameraCommand) => boolean | Promise<boolean>
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
    const audio = { autoplay: false, pause: vi.fn(), remove: vi.fn(), srcObject: null }

    const connection = await startRealtimeVoiceConnection({
      audioFactory: () => audio as never,
      fetchFn: vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => 'answer-sdp'
      })) as never,
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } as never,
      onCameraCommand,
      onConnectionClosed,
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
      audio,
      channel,
      connection,
      disconnect: () => listeners.get('close')?.({}),
      emit: (event: Record<string, unknown>) =>
        listeners.get('message')?.({ data: JSON.stringify(event) }),
      open: () => listeners.get('open')?.({}),
      peer,
      sent,
      sentTypes: () => sent.map(payload => JSON.parse(payload).type as string),
      track
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

  it('sends one transient mission continuation only while the channel is open', async () => {
    const harness = await connectHarness()

    const event = {
      type: 'response.create' as const,
      response: { instructions: 'Continue the active mission.' }
    }

    expect(harness.connection.resumeMission(event)).toBe(false)
    harness.open()
    expect(harness.connection.resumeMission(event)).toBe(true)
    expect(JSON.parse(harness.sent.at(-1) ?? '{}')).toEqual(event)

    harness.connection.close()
    expect(harness.connection.resumeMission(event)).toBe(false)
  })

  it('flushes conversation history seeded before the data channel opens', async () => {
    const harness = await connectHarness()

    harness.connection.seedHistory([
      { id: 'seed-user', role: 'user', text: 'The launch codename is cobalt mango.' },
      { id: 'seed-assistant', role: 'assistant', text: 'OK' }
    ])

    expect(harness.sent).toEqual([])

    harness.open()

    const events = harness.sent.map(raw => JSON.parse(raw))
    const seeded = events.filter(event => event.type === 'conversation.item.create')

    expect(events[0]).toMatchObject({ type: 'session.update' })
    expect(seeded).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'The launch codename is cobalt mango.' }]
        }
      },
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'OK' }]
        }
      }
    ])
  })

  it('closes the mission boundary when the remote data channel closes', async () => {
    const onConnectionClosed = vi.fn()
    const harness = await connectHarness({}, undefined, undefined, onConnectionClosed)
    harness.open()

    harness.disconnect()

    expect(onConnectionClosed).toHaveBeenCalledOnce()
    expect(
      harness.connection.resumeMission({
        type: 'response.create',
        response: { instructions: 'Continue the active mission.' }
      })
    ).toBe(false)
  })

  it('returns a failed mission resume when the data channel send throws', async () => {
    const onConnectionClosed = vi.fn()
    const harness = await connectHarness({}, undefined, undefined, onConnectionClosed)
    harness.open()
    harness.channel.send.mockImplementationOnce(() => {
      throw new Error('channel closed remotely')
    })

    expect(
      harness.connection.resumeMission({
        type: 'response.create',
        response: { instructions: 'Continue the active mission.' }
      })
    ).toBe(false)
    expect(onConnectionClosed).toHaveBeenCalledOnce()
  })

  it('uses refreshed canvas truth in tool continuations without rewriting the session', async () => {
    const harness = await connectHarness({}, undefined, async () => ({ artifacts: [] }))
    harness.open()
    harness.connection.updateWorkbenchContext('Canvas snapshot: pointing_at=planner')
    harness.sent.length = 0

    harness.connection.refreshWorkbenchContext('Canvas snapshot: pointing_at=executor')
    expect(harness.sent).toHaveLength(0)

    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-snapshot',
      name: 'session_snapshot',
      arguments: '{}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })

    await vi.waitFor(() =>
      expect(
        harness.sent
          .map(raw => JSON.parse(raw) as { response?: { instructions?: string }; type: string })
          .find(event => event.type === 'response.create')?.response?.instructions
      ).toContain('pointing_at=executor')
    )

    const continuation = harness.sent
      .map(raw => JSON.parse(raw) as { response?: { instructions?: string }; type: string })
      .find(event => event.type === 'response.create')?.response?.instructions

    expect(continuation).not.toContain('pointing_at=planner')
  })

  it('keeps voice as the redraw owner even for a legacy watcher token', async () => {
    // Older backends/configs can still advertise watcher ownership. The client
    // must fail toward the deliberate voice-owned path rather than silently
    // removing speed_draw and letting a transcript observer decide when to draw.
    const harness = await connectHarness({
      workbench_watcher: { active: true, owns_redraws: true, pipeline: 'direct' }
    })

    harness.open()

    const update = JSON.parse(harness.sent[0]) as {
      session: { instructions: string; tools: { description: string; name: string }[] }
    }

    const names = update.session.tools.map(tool => tool.name)

    expect(names).not.toContain('visualize')
    expect(names).toContain('speed_draw')
    expect(names).toContain('add_node')
    expect(names).toContain('focus')
    expect(names).toContain('go_back')
    expect(update.session.tools.find(tool => tool.name === 'speed_draw')?.description).toMatch(/whole canvas/i)
    expect(update.session.instructions).toMatch(/edits in place/i)
    expect(update.session.instructions).toMatch(/you decide when the drawing should change/i)
    expect(update.session.instructions).not.toMatch(/background canvas worker owns every full redraw/i)
  })

  it('keeps speed_draw without exposing the legacy alias when the watcher is shadow-only', async () => {
    const harness = await connectHarness({
      workbench_watcher: { active: false, owns_redraws: false, pipeline: 'direct' }
    })

    harness.open()
    const update = JSON.parse(harness.sent[0]) as { session: { tools: { name: string }[] } }

    expect(update.session.tools.map(tool => tool.name)).toContain('speed_draw')
    expect(update.session.tools.map(tool => tool.name)).not.toContain('visualize')
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

  it('keeps enough bounded actions for a three-node cinematic walkthrough', async () => {
    const harness = await connectHarness({}, undefined, async () => ({ artifacts: [] }))

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })

    for (let index = 0; index < 13; index += 1) {
      harness.emit({
        type: 'response.function_call_arguments.done',
        response_id: 'response-1',
        call_id: `call-${index}`,
        name: 'session_snapshot',
        arguments: '{}'
      })
    }

    harness.emit({ type: 'response.done', response: { id: 'response-1' } })
    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'conversation.item.create')).toHaveLength(13)
    )

    const outputs = harness.sent
      .map(raw => JSON.parse(raw) as { item?: { output?: string }; type: string })
      .filter(event => event.type === 'conversation.item.create')
      .map(event => JSON.parse(event.item?.output ?? '{}'))

    expect(outputs).not.toContainEqual({ error: 'Voice action budget exhausted' })
  })

  it('keeps the production voice loop alive beyond eight sequential tool rounds', async () => {
    const harness = await connectHarness({}, undefined, async () => ({ artifacts: [] }))

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })

    for (let index = 1; index <= 9; index += 1) {
      const responseId = `response-${index}`

      harness.emit({ type: 'response.created', response: { id: responseId } })
      harness.emit({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        call_id: `call-${index}`,
        name: 'session_snapshot',
        arguments: '{}'
      })
      harness.emit({ type: 'response.done', response: { id: responseId } })
      await vi.waitFor(() =>
        expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(index)
      )

      const continuation = harness.sent
        .map(raw => JSON.parse(raw) as { response?: { tool_choice?: string }; type: string })
        .filter(event => event.type === 'response.create')
        .at(-1)

      expect(continuation?.response?.tool_choice).not.toBe('none')
    }
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

  it('does not execute finalized arguments from a cancelled provider response', async () => {
    const requestOverride = vi.fn(async () => ({ shouldNot: 'run' }))
    const harness = await connectHarness({}, undefined, requestOverride)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-cancelled' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-cancelled',
      call_id: 'call-cancelled',
      name: 'session_snapshot',
      arguments: '{}'
    })
    harness.emit({
      type: 'response.done',
      response: { id: 'response-cancelled', status: 'cancelled' }
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(requestOverride).not.toHaveBeenCalled()
    expect(harness.sentTypes()).not.toContain('conversation.item.create')
    expect(harness.sentTypes()).not.toContain('response.create')
  })

  it('uses the general Stop checkpoint after a tool-free response', async () => {
    const request = vi.fn(async () => ({}))

    const harness = await connectHarness({}, undefined, request)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })

    for (const index of [0, 1]) {
      const responseId = `response-${index + 1}`

      harness.emit({ type: 'response.created', response: { id: responseId } })
      harness.emit({
        type: 'response.function_call_arguments.done',
        response_id: responseId,
        call_id: `call-${index + 1}`,
        name: 'session_snapshot',
        arguments: '{}'
      })
      harness.emit({ type: 'response.done', response: { id: responseId, status: 'completed' } })
      await vi.waitFor(() =>
        expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(index + 1)
      )
    }

    harness.emit({ type: 'response.created', response: { id: 'response-3' } })
    harness.emit({
      type: 'response.done',
      response: { id: 'response-3', status: 'completed' }
    })
    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(3)
    )

    const recovery = harness.sent
      .map(payload => JSON.parse(payload))
      .filter(event => event.type === 'response.create')
      .at(-1)

    expect(recovery.response.instructions).toMatch(/ended without an explicit finish_turn declaration/i)
    expect(recovery.response.instructions).toMatch(/next useful tool/i)
    expect(recovery.response.tool_choice).toBe('required')

    harness.emit({ type: 'response.created', response: { id: 'response-4' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-4',
      call_id: 'call-finish',
      name: 'finish_turn',
      arguments: '{"status":"complete"}'
    })
    harness.emit({
      type: 'response.done',
      response: { id: 'response-4', status: 'completed' }
    })
    await Promise.resolve()

    expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(3)
  })

  it('accepts a completed greeting without creating the repeated-speech checkpoint loop', async () => {
    const request = vi.fn(async () => ({}))

    const harness = await connectHarness({}, undefined, request)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-1',
      transcript: 'Hello.'
    })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-1',
      item_id: 'assistant-1',
      transcript: 'Hi! I’m here.'
    })
    harness.emit({ type: 'output_audio_buffer.stopped' })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })

    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(1)
    )
    harness.emit({ type: 'response.created', response: { id: 'response-2' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-2',
      call_id: 'call-finish',
      name: 'finish_turn',
      arguments: '{"status":"complete"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-2', status: 'completed' } })
    await Promise.resolve()

    expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(1)
    expect(request).not.toHaveBeenCalledWith('llm.oneshot', expect.anything())
  })

  it('uses an immediate required Realtime checkpoint without an auxiliary judge call', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'llm.oneshot') {
        throw new Error('auxiliary completion judging is forbidden in the live voice path')
      }

      return {}
    })

    const harness = await connectHarness({}, undefined, request)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-1',
      transcript: 'Walk me through the data flow step by step.'
    })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-1',
      item_id: 'assistant-1',
      transcript: 'Alright, we’ll walk through it step by step.'
    })
    harness.emit({ type: 'output_audio_buffer.stopped' })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })

    await vi.waitFor(() =>
      expect(
        harness.sent
          .map(raw => JSON.parse(raw))
          .find(event => event.type === 'response.create')?.response?.tool_choice
      ).toBe('required')
    )
    expect(request).not.toHaveBeenCalledWith('llm.oneshot', expect.anything())
  })

  it('checks a tool-free answer before accepting completion', async () => {
    const request = vi.fn(async () => ({}))

    const harness = await connectHarness({}, undefined, request)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-snapshot',
      name: 'session_snapshot',
      arguments: '{}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })
    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(1)
    )

    harness.emit({ type: 'response.created', response: { id: 'response-2' } })
    harness.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-2',
      item_id: 'assistant-2',
      transcript: 'The canvas contains one map.'
    })
    harness.emit({ type: 'output_audio_buffer.stopped' })
    harness.emit({ type: 'response.done', response: { id: 'response-2', status: 'completed' } })
    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(2)
    )

    harness.emit({ type: 'response.created', response: { id: 'response-3' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-3',
      call_id: 'call-finish',
      name: 'finish_turn',
      arguments: '{"status":"complete"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-3', status: 'completed' } })
    await Promise.resolve()

    expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(2)
    expect(request).not.toHaveBeenCalledWith('llm.oneshot', expect.anything())
  })

  it('keeps focus and camera together when a spoken beat carries present_step', async () => {
    const request = vi.fn(async () => ({ focused: true }))
    const onCameraCommand = vi.fn(() => true)
    const harness = await connectHarness({}, undefined, request, undefined, onCameraCommand)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-planner',
      name: 'present_step',
      arguments: '{"subject_id":"planner","framing":"close"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.focus', {
        node_id: 'planner',
        session_id: 'runtime-session'
      })
    )
    await vi.waitFor(() =>
      expect(onCameraCommand).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'zoom_to', nodeId: 'planner' }),
        expect.anything()
      )
    )

    request.mockClear()
    onCameraCommand.mockClear()
    harness.emit({ type: 'response.created', response: { id: 'response-2' } })
    harness.emit({ type: 'output_audio_buffer.started' })
    harness.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-2',
      item_id: 'assistant-planner',
      transcript: 'The Planner decides what happens next.'
    })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-2',
      call_id: 'call-executor',
      name: 'present_step',
      arguments: '{"subject_id":"executor","framing":"close","transition":"quick"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-2', status: 'completed' } })

    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()
    expect(onCameraCommand).not.toHaveBeenCalled()

    harness.emit({ type: 'output_audio_buffer.stopped' })
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.focus', {
        node_id: 'executor',
        session_id: 'runtime-session'
      })
    )
    expect(onCameraCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'zoom_to', nodeId: 'executor', transition: 'quick' }),
      expect.anything()
    )
  })

  it('keeps a walkthrough alive across a spoken beat that carries the next focus', async () => {
    // The 8/20 shape, pinned. The model bundles "explain A + focus B" into one
    // response, so response.calls is non-empty and the turn does NOT settle.
    // A spoken beat that also carries the next action must keep the loop alive.
    const request = vi.fn(async () => ({ artifact: { semantic_rev: 2, view_rev: 1 } }))
    const harness = await connectHarness({}, undefined, request)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-1',
      transcript: 'Walk me through it from the beginning.'
    })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-planner',
      name: 'focus',
      arguments: '{"node_id":"planner"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.focus', {
        node_id: 'planner',
        session_id: 'runtime-session'
      })
    )
    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(1)
    )

    // Beat two: speech AND the next focus in the same response, with audio
    // playing. The barrier holds focus(executor) until playback ends.
    harness.emit({ type: 'response.created', response: { id: 'response-2' } })
    harness.emit({ type: 'output_audio_buffer.started' })
    harness.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-2',
      item_id: 'assistant-planner',
      transcript: 'We start with the Planner. It decides what to do next.'
    })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-2',
      call_id: 'call-executor',
      name: 'focus',
      arguments: '{"node_id":"executor"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-2', status: 'completed' } })

    await Promise.resolve()
    expect(request).not.toHaveBeenCalledWith('workbench.focus', {
      node_id: 'executor',
      session_id: 'runtime-session'
    })

    harness.emit({ type: 'output_audio_buffer.stopped' })

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.focus', {
        node_id: 'executor',
        session_id: 'runtime-session'
      })
    )
    // The turn is still alive: a second continuation was created, so the model
    // gets another inference to explain Executor and reach for Reviser.
    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(2)
    )
  })

  it('walks focus A then explanation A then focus B at the audio boundary', async () => {
    const request = vi.fn(async () => ({ artifact: { semantic_rev: 2, view_rev: 1 } }))
    const harness = await connectHarness({}, undefined, request)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-mic',
      name: 'focus',
      arguments: '{"node_id":"mic"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.focus', {
        node_id: 'mic',
        session_id: 'runtime-session'
      })
    )

    harness.emit({ type: 'response.created', response: { id: 'response-2' } })
    harness.emit({ type: 'output_audio_buffer.started' })
    harness.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-2',
      item_id: 'assistant-mic',
      transcript: 'Mic audio is where speech enters the system.'
    })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-2',
      call_id: 'call-vad',
      name: 'focus',
      arguments: '{"node_id":"vad"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-2', status: 'completed' } })

    await Promise.resolve()
    expect(request).not.toHaveBeenCalledWith('workbench.focus', {
      node_id: 'vad',
      session_id: 'runtime-session'
    })

    harness.emit({ type: 'output_audio_buffer.stopped' })

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.focus', {
        node_id: 'vad',
        session_id: 'runtime-session'
      })
    )
    expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(2)
  })

  it('challenges a walkthrough that stops after explaining only the first node', async () => {
    const request = vi.fn(async () => ({ artifact: { semantic_rev: 2, view_rev: 1 } }))

    const harness = await connectHarness({}, undefined, request)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-1',
      transcript: 'Walk me through step by step.'
    })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-planner',
      name: 'focus',
      arguments: '{"node_id":"planner"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.focus', {
        node_id: 'planner',
        session_id: 'runtime-session'
      })
    )
    // Wait for the round's own continuation: that is the proof the tool round
    // finished and recorded its execution before the next response arrives.
    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(1)
    )

    // The regression: the model explains Planner and stops, leaving Executor
    // and Reviser unvisited. The required checkpoint must send it onward.
    harness.sent.length = 0
    harness.emit({ type: 'response.created', response: { id: 'response-2' } })
    harness.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-2',
      item_id: 'assistant-planner',
      transcript: 'First, this Planner is where the intent forms.'
    })
    harness.emit({ type: 'output_audio_buffer.stopped' })
    harness.emit({ type: 'response.done', response: { id: 'response-2', status: 'completed' } })

    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(1)
    )

    const challenge = harness.sent
      .map(raw => JSON.parse(raw) as { response?: { instructions?: string; tool_choice?: string }; type: string })
      .find(event => event.type === 'response.create')?.response

    expect(challenge?.instructions).toMatch(/ended without an explicit finish_turn declaration/i)
    expect(challenge?.instructions).toMatch(/next useful tool/i)
    expect(challenge?.tool_choice).toBe('required')

    const stopContext = challenge?.instructions?.match(
      /Stop checkpoint context:\n([\s\S]*?)\n\nCompleted actions:/
    )?.[1] ?? ''

    expect(stopContext).not.toMatch(/planner|node|subject|present_step|focus/i)
  })

  it('ends a completed walkthrough through the same explicit terminal declaration', async () => {
    const request = vi.fn(async () => ({ artifact: { semantic_rev: 2, view_rev: 1 } }))
    const harness = await connectHarness({}, undefined, request)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-1',
      transcript: 'Walk me through step by step.'
    })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-reset',
      name: 'reset_view',
      arguments: '{}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })
    await vi.waitFor(() =>
      expect(harness.sentTypes().filter(type => type === 'response.create')).toHaveLength(1)
    )

    harness.sent.length = 0
    harness.emit({ type: 'response.created', response: { id: 'response-2' } })
    harness.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-2',
      item_id: 'assistant-close',
      transcript: 'And that closes the loop.'
    })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-2',
      call_id: 'call-finish',
      name: 'finish_turn',
      arguments: '{"status":"complete","reason":"The full walkthrough is complete."}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-2', status: 'completed' } })
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.sentTypes()).not.toContain('response.create')
  })

  it('draws node A then explains A before drawing node B', async () => {
    const request = vi.fn(async () => ({ artifact: { semantic_rev: 2, view_rev: 1 } }))
    const harness = await connectHarness({}, undefined, request)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-planner',
      name: 'add_node',
      arguments: '{"id":"planner","label":"Planner","kind":"agent"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.edit', {
        edit: { id: 'planner', kind: 'agent', label: 'Planner', op: 'add_node' },
        session_id: 'runtime-session'
      })
    )

    harness.emit({ type: 'response.created', response: { id: 'response-2' } })
    harness.emit({ type: 'output_audio_buffer.started' })
    harness.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-2',
      item_id: 'assistant-planner',
      transcript: 'Planner decides what should happen next.'
    })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-2',
      call_id: 'call-executor',
      name: 'add_node',
      arguments: '{"id":"executor","label":"Executor","kind":"system"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-2', status: 'completed' } })

    await Promise.resolve()
    expect(request).not.toHaveBeenCalledWith('workbench.edit', {
      edit: { id: 'executor', kind: 'system', label: 'Executor', op: 'add_node' },
      session_id: 'runtime-session'
    })

    harness.emit({ type: 'output_audio_buffer.stopped' })
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.edit', {
        edit: { id: 'executor', kind: 'system', label: 'Executor', op: 'add_node' },
        session_id: 'runtime-session'
      })
    )
  })

  it('drops a queued focus when the user barges in during its audio barrier', async () => {
    const request = vi.fn(async () => ({ artifact: { semantic_rev: 2, view_rev: 1 } }))
    const harness = await connectHarness({}, undefined, request)

    harness.open()
    harness.sent.length = 0
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({ type: 'output_audio_buffer.started' })
    harness.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'response-1',
      item_id: 'assistant-mic',
      transcript: 'Mic audio is where speech enters.'
    })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-vad',
      name: 'focus',
      arguments: '{"node_id":"vad"}'
    })
    harness.emit({ type: 'response.done', response: { id: 'response-1', status: 'completed' } })

    await Promise.resolve()
    harness.emit({ type: 'input_audio_buffer.speech_started' })
    await Promise.resolve()
    await Promise.resolve()

    expect(request).not.toHaveBeenCalledWith('workbench.focus', {
      node_id: 'vad',
      session_id: 'runtime-session'
    })
    expect(harness.sentTypes()).toContain('response.cancel')
    expect(harness.sentTypes()).toContain('output_audio_buffer.clear')
    expect(harness.sentTypes()).not.toContain('response.create')
  })

  it('releases every resource when closing with a pending tool call', async () => {
    const harness = await connectHarness()

    harness.open()
    harness.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    harness.emit({ type: 'response.created', response: { id: 'response-1' } })
    harness.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'response-1',
      call_id: 'call-pending',
      name: 'session_snapshot',
      arguments: '{}'
    })
    harness.channel.send.mockImplementation(() => {
      throw new Error('channel closing')
    })

    expect(() => harness.connection.close()).not.toThrow()
    expect(harness.track.stop).toHaveBeenCalledOnce()
    expect(harness.channel.close).toHaveBeenCalledOnce()
    expect(harness.peer.close).toHaveBeenCalledOnce()
    expect(harness.audio.pause).toHaveBeenCalledOnce()
    expect(harness.audio.remove).toHaveBeenCalledOnce()
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
      'finish_turn',
      'session_snapshot',
      'speed_draw',
      'delegate_research',
      'research_status',
      'research_search',
      'research_read',
      // Surgical tools: one thing, instantly, with no diagrammer round trip.
      'add_node',
      'present_step',
      'focus',
      'zoom_to',
      'frame_nodes',
      'pan_view',
      'zoom_view',
      'reset_view',
      'go_back',
      'rename',
      'connect',
      'disconnect',
      'remove'
    ])

    const toolDescriptions = new Map(
      sessionUpdate.session.tools.map((tool: { description: string; name: string }) => [
        tool.name,
        tool.description
      ])
    )

    expect(toolDescriptions.get('session_snapshot')).toMatch(/nodes.*edges.*revisions.*view state/i)
    expect(toolDescriptions.get('speed_draw')).toMatch(/ONLY.*explicitly.*quick draft.*all at once.*rearrange/is)
    expect(toolDescriptions.get('speed_draw')).toMatch(/step by step.*live narrated/is)
    expect(toolDescriptions.get('add_node')).toMatch(/one-off edit.*present_step/is)
    expect(toolDescriptions.get('present_step')).toMatch(/single coherent visual action/i)
    expect(toolDescriptions.get('present_step')).toMatch(/ring the subject.*camera/is)
    expect(toolDescriptions.get('focus')).toMatch(/one-off highlight.*present_step/is)
    expect(toolDescriptions.get('connect')).toMatch(/add_node.*then.*connect/i)
    expect(toolDescriptions.get('connect')).toMatch(/speed_draw.*broad/i)

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

  it('completes one interactive Peeps fallback, then retries the realtime token once', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'interaction_required',
        auth_session_id: 'auth-session',
        authority: 'https://login.microsoftonline.com/organizations',
        client_id: 'client-id',
        public_key: 'backend-public-key',
        redirect_uri: 'https://localhost:8080/',
        scope: 'https://peeps.asgprototype.com/api/access-as-user',
        state: 'state-123',
        timeout_seconds: 1
      })
      .mockResolvedValueOnce({
        client_secret: 'ek_short',
        model: 'gpt-realtime-2.1',
        voice: 'marin'
      })

    const complete = vi.fn().mockResolvedValue(true)

    vi.stubGlobal('window', {
      hermesDesktop: { peepsVoiceAuth: { complete, cancel: vi.fn().mockResolvedValue(true) } }
    })
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

    const connection = await startRealtimeVoiceConnection({
      audioFactory: () =>
        ({ autoplay: false, pause: vi.fn(), remove: vi.fn(), srcObject: null }) as never,
      fetchFn: vi.fn(async () => ({ ok: true, status: 200, text: async () => 'answer-sdp' })) as never,
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [{ enabled: true, stop: vi.fn() }] }))
      } as never,
      peerConnectionFactory: () => peer as never,
      request,
      runtimeSessionId: 'runtime-session'
    })

    expect(complete).toHaveBeenCalledWith({
      authSessionId: 'auth-session',
      connectionId: null,
      profile: 'default',
      runtimeSessionId: 'runtime-session'
    })
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      'voice.realtime.token',
      'voice.realtime.token'
    ])
    expect(request.mock.calls[1]?.[1]).toEqual({
      session_id: 'runtime-session',
      peeps_auth_session_id: 'auth-session'
    })
    expect(JSON.stringify(request.mock.calls)).not.toContain('peeps-token')
    expect(JSON.stringify(request.mock.calls)).not.toContain('peeps_token')
    connection.close()
  })

  it('cancels an interactive auth start before microphone access when the caller aborts', async () => {
    const getUserMedia = vi.fn()
    const controller = new AbortController()
    let releaseCompletion: (() => void) | undefined
    const cancel = vi.fn().mockResolvedValue(true)

    const request = vi.fn().mockResolvedValue({
      status: 'interaction_required',
      auth_session_id: 'auth-session',
      authority: 'https://login.microsoftonline.com/organizations',
      client_id: 'client-id',
      public_key: 'backend-public-key',
      redirect_uri: 'https://localhost:8080/',
      scope: 'https://peeps.asgprototype.com/api/access-as-user',
      state: 'state-123',
      timeout_seconds: 1
    })

    vi.stubGlobal('window', {
      hermesDesktop: {
        peepsVoiceAuth: {
          cancel,
          complete: vi.fn(() => new Promise<boolean>(resolve => {
            releaseCompletion = () => resolve(true)
          }))
        }
      }
    })

    const pending = startRealtimeVoiceConnection({
      mediaDevices: { getUserMedia } as never,
      request,
      runtimeSessionId: 'runtime-session',
      signal: controller.signal
    })

    controller.abort()
    releaseCompletion?.()

    await expect(pending).rejects.toThrow(/cancelled/i)
    expect(cancel).toHaveBeenCalledWith('auth-session')
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(request.mock.calls.map(([method]) => method)).toEqual(['voice.realtime.token'])
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
    expect(harness.sentTypes()).toContain('response.cancel')
    expect(harness.sentTypes()).toContain('output_audio_buffer.clear')
    expect(harness.sentTypes().indexOf('response.cancel')).toBeLessThan(
      harness.sentTypes().indexOf('output_audio_buffer.clear')
    )

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
