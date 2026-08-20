import { describe, expect, it, vi } from 'vitest'

import { executeRealtimeVoiceTool } from './realtime-voice'

/**
 * The transcription gate belongs on the SLOW path only.
 *
 * `beforeToolCall` waits for pending input transcriptions plus the durable
 * transcript write chain. That is load-bearing for `visualize`, which reads
 * the durable transcript to decide what to draw — drawing from a transcript
 * missing the user's last sentence produces a diagram of the wrong
 * conversation.
 *
 * It is pure latency for the surgical tools. `focus` takes a node id the model
 * already has; `rename` takes a label it just said out loud. Neither reads the
 * transcript at all, so gating them adds a stall to the one path whose entire
 * purpose is to feel instant (measured server-side at 9-13ms).
 */
const slowGate = () => {
  let release: (() => void) | undefined

  const gate = new Promise<void>(resolve => {
    release = resolve
  })

  return { beforeToolCall: () => gate, release: release as () => void }
}

const call = (name: string, args: string) => ({
  arguments: args,
  callId: `call-${name}`,
  name,
  responseId: 'response-1'
})

describe('the transcription gate does not slow the instant tools', () => {
  it('does not gate focus behind pending transcription', async () => {
    const { beforeToolCall } = slowGate()
    const request = vi.fn(async () => ({ artifact: { semantic_rev: 2 } }))
    // The gate is never released. If focus waited on it, this would hang.
    await executeRealtimeVoiceTool(call('focus', '{"node_id":"planner"}'), {
      beforeToolCall,
      request,
      runtimeSessionId: 'sess-1'
    })

    expect(request).toHaveBeenCalledWith('workbench.focus', {
      node_id: 'planner',
      session_id: 'sess-1'
    })
  })

  it('does not gate rename, connect, disconnect, remove or go_back', async () => {
    for (const [name, args] of [
      ['rename', '{"node_id":"a","label":"Planner"}'],
      ['connect', '{"from_id":"a","to_id":"b"}'],
      ['disconnect', '{"edge_id":"e1"}'],
      ['remove', '{"node_id":"a"}'],
      ['go_back', '{}']
    ] as const) {
      const { beforeToolCall } = slowGate()
      const request = vi.fn(async () => ({ artifact: { semantic_rev: 2 } }))

      await executeRealtimeVoiceTool(call(name, args), {
        beforeToolCall,
        request,
        runtimeSessionId: 'sess-1'
      })

      expect(request, `${name} should not wait for transcription`).toHaveBeenCalled()
    }
  })

  it('STILL gates visualize, which reads the durable transcript', async () => {
    // The gate exists for exactly this: a redraw that starts before the user's
    // last sentence lands draws the wrong conversation.
    const { beforeToolCall, release } = slowGate()
    const request = vi.fn(async () => ({ artifact: { semantic_rev: 2 } }))

    const routed = executeRealtimeVoiceTool(call('visualize', '{}'), {
      beforeToolCall,
      request,
      runtimeSessionId: 'sess-1'
    })

    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()

    release()
    await routed
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('workbench.visualize', expect.anything())
    )
  })

  it('STILL gates session_snapshot, which reads stored state', async () => {
    const { beforeToolCall, release } = slowGate()
    const request = vi.fn(async () => ({ artifacts: [] }))

    const routed = executeRealtimeVoiceTool(call('session_snapshot', '{}'), {
      beforeToolCall,
      request,
      runtimeSessionId: 'sess-1'
    })

    await Promise.resolve()
    expect(request).not.toHaveBeenCalled()

    release()
    await routed
    expect(request).toHaveBeenCalled()
  })
})
