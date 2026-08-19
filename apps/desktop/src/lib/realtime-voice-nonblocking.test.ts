import { describe, expect, it, vi } from 'vitest'

import { routeRealtimeServerEvent } from './realtime-voice'

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
  runtimeSessionId: 'sess-1',
  send: vi.fn()
})

const visualizeEvent = {
  type: 'response.function_call_arguments.done',
  call_id: 'call-1',
  name: 'visualize',
  arguments: '{"prompt":"add the memory layer"}'
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

    await routeRealtimeServerEvent(visualizeEvent, d as never)

    // The slow redraw is still in flight...
    expect(request).toHaveBeenCalledWith('workbench.visualize', expect.anything())
    // ...but the model already has its result and can keep speaking.
    const sent = d.send.mock.calls.map(c => c[0] as { item?: { type?: string }; type: string })
    expect(sent.some(e => e.item?.type === 'function_call_output')).toBe(true)
    expect(sent.some(e => e.type === 'response.create')).toBe(true)

    resolveRedraw?.({ artifact: { semantic_rev: 2 } })
  })

  it('tells the model the drawing is in progress, not that it is done', async () => {
    const request = vi.fn(() => new Promise(() => {}))
    const d = deps(request)

    await routeRealtimeServerEvent(visualizeEvent, d as never)

    const output = d.send.mock.calls
      .map(c => c[0] as { item?: { output?: string; type?: string } })
      .find(e => e.item?.type === 'function_call_output')

    const parsed = JSON.parse(output?.item?.output ?? '{}') as { status?: string }

    // Claiming success would make the model announce a drawing that may still
    // fail; claiming nothing would make it think the tool broke.
    expect(parsed.status).toBe('drawing')
  })

  it('still awaits surgical edits, which are milliseconds not seconds', async () => {
    // Measured: rename 13ms, focus 9ms. These are fast enough to await, and
    // the model needs the real result to talk about what changed.
    const request = vi.fn(async () => ({ artifact: { semantic_rev: 5 } }))
    const d = deps(request)

    await routeRealtimeServerEvent(
      {
        type: 'response.function_call_arguments.done',
        call_id: 'call-2',
        name: 'rename',
        arguments: '{"node_id":"a","label":"Planner"}'
      },
      d as never
    )

    const output = d.send.mock.calls
      .map(c => c[0] as { item?: { output?: string; type?: string } })
      .find(e => e.item?.type === 'function_call_output')

    const parsed = JSON.parse(output?.item?.output ?? '{}') as { artifact?: unknown }

    expect(parsed.artifact).toBeDefined()
  })
})
