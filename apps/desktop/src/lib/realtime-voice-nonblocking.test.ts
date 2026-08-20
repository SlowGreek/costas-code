import { describe, expect, it, vi } from 'vitest'

import { executeRealtimeVoiceTool } from './realtime-voice'

/**
 * `visualize` must not block the conversation.
 *
 * Measured on the running app, a full redraw takes ~9s. Awaiting it before
 * returning a tool result freezes the realtime turn for that whole time, which
 * is what the user experienced as "close but not fluid enough":
 *
 *     10:37:09  assistant  "Okay, I'll walk through it visually..."
 *     ...10 seconds of silence...
 *     10:37:18  assistant  "Picture the box you're looking at as a bouncer..."
 *
 * The drawing is already delivered to the canvas by the `artifact.updated`
 * gateway event, so the model does not need to wait for it to keep talking.
 */
const deps = (request: ReturnType<typeof vi.fn>) => ({
  request,
  runtimeSessionId: 'sess-1'
})

const visualizeEvent = {
  arguments: '{"prompt":"add the memory layer"}',
  callId: 'call-1',
  name: 'visualize',
  responseId: 'response-1'
}

describe('visualize does not block the conversation', () => {
  it('returns a tool result immediately instead of awaiting the redraw', async () => {
    let resolveRedraw: ((value: unknown) => void) | undefined

    const request = vi.fn(
      () =>
        new Promise(resolve => {
          resolveRedraw = resolve
        })
    )

    const d = deps(request)

    const output = await executeRealtimeVoiceTool(visualizeEvent, d as never)

    // The slow redraw is still in flight...
    expect(request).toHaveBeenCalledWith('workbench.visualize', expect.anything())
    // ...but the controller already has its result and can keep the semantic
    // turn moving once the enclosing provider response closes.
    expect(output).toEqual({ status: 'drawing' })

    resolveRedraw?.({ artifact: { semantic_rev: 2 } })
  })

  it('tells the model the drawing is in progress, not that it is done', async () => {
    const request = vi.fn(() => new Promise(() => {}))
    const d = deps(request)

    const output = (await executeRealtimeVoiceTool(visualizeEvent, d as never)) as { status?: string }

    // Claiming success would make the model announce a drawing that may still
    // fail; claiming nothing would make it think the tool broke.
    expect(output.status).toBe('drawing')
  })

  it('still awaits surgical edits, which are milliseconds not seconds', async () => {
    // Measured: rename 13ms, focus 9ms. These are fast enough to await, and
    // the model needs the real result to talk about what changed.
    const request = vi.fn(async () => ({ artifact: { semantic_rev: 5 } }))
    const d = deps(request)

    const output = await executeRealtimeVoiceTool(
      {
        arguments: '{"node_id":"a","label":"Planner"}',
        callId: 'call-2',
        name: 'rename',
        responseId: 'response-1'
      },
      d as never
    )

    expect((output as { artifact?: unknown }).artifact).toBeDefined()
  })
})
