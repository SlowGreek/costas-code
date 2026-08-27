import { describe, expect, it, vi } from 'vitest'

import { startRealtimeVoiceConnection } from './realtime-voice'

/**
 * The literal live failure, replayed: session 20260826_112445_ca2284.
 *
 * "Let's walk through it from the beginning." -> focus(planner) -> a spoken
 * response that explains Planner and carries NO tool call. Every mocked test
 * so far passed while this exact shape stalled in production, so this asserts
 * the only thing that matters for the demo: after that spoken beat, does the
 * harness create another response so the model can reach Executor?
 */
describe('live walkthrough replay', () => {
  const harness = async () => {
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

    await startRealtimeVoiceConnection({
      audioFactory: () => ({ autoplay: false, pause: vi.fn(), remove: vi.fn(), srcObject: null }) as never,
      fetchFn: vi.fn(async () => ({ ok: true, status: 200, text: async () => 'answer-sdp' })) as never,
      mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } as never,
      peerConnectionFactory: () => peer as never,
      request: vi.fn(async (method: string) =>
        method === 'voice.realtime.token'
          ? { client_secret: 'ek', model: 'gpt-realtime-2.1', voice: 'marin' }
          : method === 'llm.oneshot'
            ? {
                text: JSON.stringify({
                  verdict: 'continue',
                  reason: 'The requested walkthrough is incomplete.'
                })
              }
            : { artifact: { semantic_rev: 2, view_rev: 1 } }
      ),
      runtimeSessionId: 'runtime-session'
    })

    return {
      emit: (event: Record<string, unknown>) =>
        listeners.get('message')?.({ data: JSON.stringify(event) }),
      open: () => listeners.get('open')?.({}),
      sent,
      types: () => sent.map(payload => JSON.parse(payload).type as string)
    }
  }

  it('creates another response after a spoken beat with no tool call', async () => {
    const h = await harness()

    h.open()
    h.sent.length = 0

    h.emit({ type: 'input_audio_buffer.committed', item_id: 'user-1' })
    h.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user-1',
      transcript: "Let's walk through it from the beginning."
    })

    // Beat one: acknowledgement + focus(planner).
    h.emit({ type: 'response.created', response: { id: 'resp-1' } })
    h.emit({ type: 'output_audio_buffer.started' })
    h.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp-1',
      item_id: 'a-1',
      transcript: "Okay, let's walk through it step by step from the top."
    })
    h.emit({
      type: 'response.function_call_arguments.done',
      response_id: 'resp-1',
      call_id: 'call-planner',
      name: 'focus',
      arguments: '{"node_id":"planner"}'
    })
    h.emit({ type: 'output_audio_buffer.stopped' })
    h.emit({ type: 'response.done', response: { id: 'resp-1', status: 'completed' } })

    await vi.waitFor(() =>
      expect(h.types().filter(t => t === 'response.create')).toHaveLength(1)
    )

    // Beat two: the exact production stall -- speech, no tool call.
    h.sent.length = 0
    h.emit({ type: 'response.created', response: { id: 'resp-2' } })
    h.emit({ type: 'output_audio_buffer.started' })
    h.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp-2',
      item_id: 'a-2',
      transcript:
        'We start with the Planner. It decides what to do next, then passes the plan to the Executor.'
    })
    h.emit({ type: 'output_audio_buffer.stopped' })
    h.emit({ type: 'response.done', response: { id: 'resp-2', status: 'completed' } })

    await vi.waitFor(() =>
      expect(h.types().filter(t => t === 'response.create')).toHaveLength(1)
    )

    const continuation = h.sent
      .map(raw => JSON.parse(raw))
      .find(event => event.type === 'response.create')

    expect(continuation.response.tool_choice).toBe('required')
  })
})
