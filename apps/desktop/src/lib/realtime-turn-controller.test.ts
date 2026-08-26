import { describe, expect, it, vi } from 'vitest'

import { createRealtimeTurnController } from './realtime-turn-controller'

const call = (responseId: string, callId: string, name: string) => ({
  arguments: '{}',
  callId,
  name,
  responseId
})

function deferred<T>() {
  let resolve!: (value: T) => void

  const promise = new Promise<T>(res => {
    resolve = res
  })

  return { promise, resolve }
}

describe('RealtimeTurnController', () => {
  it('scopes semantic turn ids to the voice connection', () => {
    const controller = createRealtimeTurnController({
      execute: vi.fn(),
      send: vi.fn(),
      turnIdPrefix: 'voice-connection-a-turn'
    })

    expect(controller.beginTurn('First request.')).toBe('voice-connection-a-turn-1')
    expect(controller.beginTurn('Second request.')).toBe('voice-connection-a-turn-2')
  })

  it('collects every call in one response and creates exactly one continuation', async () => {
    const sent: Record<string, unknown>[] = []
    const execute = vi.fn(async ({ name }: { name: string }) => ({ ok: name }))
    const controller = createRealtimeTurnController({ execute, send: event => sent.push(event) })

    controller.beginTurn('Compare the current approaches and show the strongest option.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-search', 'web_search'))
    controller.functionCallDone(call('response-1', 'call-snapshot', 'session_snapshot'))

    const outcome = await controller.responseDone('response-1')

    expect(execute).toHaveBeenCalledTimes(2)
    expect(sent.filter(event => event.type === 'conversation.item.create')).toHaveLength(2)
    expect(sent.filter(event => event.type === 'response.create')).toHaveLength(1)
    expect(sent.at(-1)).toMatchObject({
      type: 'response.create',
      response: { instructions: expect.stringMatching(/same semantic turn/i) }
    })
    expect(outcome).toEqual({ continued: true, settled: false })
  })

  it('retains ordered tool arguments and results as execution memory', async () => {
    const send = vi.fn()

    const controller = createRealtimeTurnController({
      execute: async ({ name }) =>
        name === 'focus' ? { focused: 'mic' } : { artifacts: ['map.main'] },
      send
    })

    controller.beginTurn('Inspect and focus the first node.')
    controller.responseCreated('response-1')
    controller.functionCallDone({
      arguments: '{"node_id":"mic"}',
      callId: 'call-focus',
      name: 'focus',
      responseId: 'response-1'
    })
    controller.functionCallDone({
      arguments: '{}',
      callId: 'call-snapshot',
      name: 'session_snapshot',
      responseId: 'response-1'
    })
    await controller.responseDone('response-1')

    expect(controller.activeTurn()?.executions).toEqual([
      {
        arguments: '{"node_id":"mic"}',
        callId: 'call-focus',
        name: 'focus',
        output: { focused: 'mic' },
        responseId: 'response-1',
        status: 'success'
      },
      {
        arguments: '{}',
        callId: 'call-snapshot',
        name: 'session_snapshot',
        output: { artifacts: ['map.main'] },
        responseId: 'response-1',
        status: 'success'
      }
    ])
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      response: {
        instructions: expect.stringMatching(
          /focus\(\{"node_id":"mic"\}\)[\s\S]*focused[\s\S]*mic/i
        )
      },
      type: 'response.create'
    })
  })

  it('retains session instructions on every tool continuation response', async () => {
    const send = vi.fn()

    const controller = createRealtimeTurnController({
      baseInstructions: () =>
        'During a walkthrough, focus exactly one node and explain only that node.',
      execute: async () => ({ focused: 'mic' }),
      send
    })

    controller.beginTurn('Walk through the chart node by node.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-focus', 'focus'))
    await controller.responseDone('response-1')

    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'response.create',
      response: {
        instructions: expect.stringMatching(
          /focus exactly one node[\s\S]*Continue the same semantic turn/i
        )
      }
    })
  })

  it('runs consecutive independent reads concurrently', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    const started: string[] = []

    const controller = createRealtimeTurnController({
      execute: ({ callId }) => {
        started.push(callId)

        return callId === 'call-1' ? first.promise : second.promise
      },
      laneFor: () => 'read',
      send: vi.fn()
    })

    controller.beginTurn('Compare two current sources.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-1', 'web_search'))
    controller.functionCallDone(call('response-1', 'call-2', 'web_search'))
    const completing = controller.responseDone('response-1')

    await vi.waitFor(() => expect(started).toEqual(['call-1', 'call-2']))
    first.resolve({ one: true })
    second.resolve({ two: true })
    await completing
  })

  it('keeps durable edits serial and ordered', async () => {
    const first = deferred<unknown>()
    const started: string[] = []

    const controller = createRealtimeTurnController({
      execute: async ({ callId }) => {
        started.push(callId)

        if (callId === 'call-1') {
          return first.promise
        }

        return { second: true }
      },
      laneFor: () => 'edit',
      send: vi.fn()
    })

    controller.beginTurn('Apply these exact edits.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-1', 'rename'))
    controller.functionCallDone(call('response-1', 'call-2', 'connect'))
    const completing = controller.responseDone('response-1')

    await vi.waitFor(() => expect(started).toEqual(['call-1']))
    first.resolve({ first: true })
    await completing
    expect(started).toEqual(['call-1', 'call-2'])
  })

  it('coalesces repeated gesture calls to the latest target', async () => {
    const execute = vi.fn(async ({ callId }) => ({ focused: callId }))
    const sent: Record<string, unknown>[] = []

    const controller = createRealtimeTurnController({
      execute,
      laneFor: () => 'gesture',
      send: event => sent.push(event)
    })

    controller.beginTurn('Point at the relevant box.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-old', 'focus'))
    controller.functionCallDone(call('response-1', 'call-new', 'focus'))
    await controller.responseDone('response-1')

    expect(execute).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-new' }))

    const outputs = sent
      .filter(event => event.type === 'conversation.item.create')
      .map(event => JSON.parse((event.item as { output: string }).output))

    expect(outputs).toEqual([{ superseded: true }, { focused: 'call-new' }])
  })

  it('requires speech between focus rounds instead of silently skipping the graph', async () => {
    const execute = vi.fn(async ({ arguments: raw }) => ({
      focused: JSON.parse(raw).node_id
    }))

    const controller = createRealtimeTurnController({
      execute,
      laneFor: () => 'gesture',
      send: vi.fn()
    })

    controller.beginTurn('Explain each node as you focus it.')
    controller.responseCreated('response-1')
    controller.functionCallDone({
      arguments: '{"node_id":"mic"}',
      callId: 'call-mic',
      name: 'focus',
      responseId: 'response-1'
    })
    await controller.responseDone('response-1')

    controller.responseCreated('response-2')
    controller.functionCallDone({
      arguments: '{"node_id":"vad"}',
      callId: 'call-vad-too-early',
      name: 'focus',
      responseId: 'response-2'
    })
    await controller.responseDone('response-2')

    expect(execute).toHaveBeenCalledOnce()
    expect(controller.activeTurn()?.executions.at(-1)).toMatchObject({
      callId: 'call-vad-too-early',
      output: { narration_required: true },
      status: 'skipped'
    })

    controller.responseCreated('response-3')
    controller.assistantTranscriptDone('response-3', 'Mic audio is where speech enters.')
    controller.assistantAudioStarted()
    controller.functionCallDone({
      arguments: '{"node_id":"vad"}',
      callId: 'call-vad',
      name: 'focus',
      responseId: 'response-3'
    })
    const completing = controller.responseDone('response-3')

    await Promise.resolve()
    expect(execute).toHaveBeenCalledOnce()

    controller.assistantAudioEnded()
    await completing

    expect(execute).toHaveBeenCalledTimes(2)
    expect(controller.activeTurn()?.executions.at(-1)).toMatchObject({
      callId: 'call-vad',
      output: { focused: 'vad' },
      status: 'success'
    })
  })

  it('executes a duplicate call id only once', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const send = vi.fn()
    const controller = createRealtimeTurnController({ execute, send })

    controller.beginTurn('Inspect the canvas.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-1', 'session_snapshot'))
    controller.functionCallDone(call('response-1', 'call-1', 'session_snapshot'))
    await controller.responseDone('response-1')

    expect(execute).toHaveBeenCalledTimes(1)
    expect(
      send.mock.calls.filter(([event]) => event.type === 'conversation.item.create')
    ).toHaveLength(1)
  })

  it('rejects call events without response identity', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const send = vi.fn()
    const controller = createRealtimeTurnController({ execute, send })

    controller.beginTurn('Inspect the canvas.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('', 'call-1', 'session_snapshot'))
    const outcome = await controller.responseDone('response-1')

    expect(execute).not.toHaveBeenCalled()
    expect(outcome).toEqual({ continued: false, settled: true })
    expect(send).not.toHaveBeenCalled()
  })

  it('settles a response with no tool calls', async () => {
    const controller = createRealtimeTurnController({ execute: vi.fn(), send: vi.fn() })

    const turnId = controller.beginTurn('Answer directly.')
    controller.responseCreated('response-1')

    await expect(controller.responseDone('response-1')).resolves.toEqual({
      continued: false,
      settled: true
    })
    expect(controller.activeTurn()).toBeNull()
    expect(controller.turnIdForResponse('response-1')).toBe(turnId)
  })

  it('lets an FX-style Stop checkpoint continue one tool-free candidate once', async () => {
    const send = vi.fn()

    const stop = vi.fn(async input => {
      expect(input.candidateText).toBe('I explained only the first step.')
      expect(input.turn.goal).toBe('Explain every step.')
      expect(input.canContinue).toBe(true)

      return { context: 'The original request is incomplete. Continue.', kind: 'continue_once' } as const
    })

    const controller = createRealtimeTurnController({ execute: vi.fn(), send, stop })

    const turnId = controller.beginTurn('Explain every step.')
    controller.responseCreated('response-1')
    controller.assistantTranscriptDone('response-1', 'I explained only the first step.')

    await expect(controller.responseDone('response-1')).resolves.toEqual({
      continued: true,
      settled: false
    })
    expect(controller.activeTurn()?.id).toBe(turnId)
    expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
      response: { instructions: expect.stringMatching(/original request is incomplete/i) },
      type: 'response.create'
    })

    controller.responseCreated('response-2')
    controller.assistantTranscriptDone('response-2', 'Now every step is covered.')
    await expect(controller.responseDone('response-2')).resolves.toEqual({
      continued: false,
      settled: true
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(controller.activeTurn()).toBeNull()
  })

  it('lets a spoken beat carry the next presentation instead of skipping it', async () => {
    // Narration debt exists so two focuses cannot fire back-to-back with no
    // explanation between them. But when the SAME response both explains the
    // current node and reaches for the next one, the debt is already paid --
    // skipping that call is what strands a walkthrough after one node.
    const executed: string[] = []

    const controller = createRealtimeTurnController({
      execute: async call => {
        executed.push(call.name)

        return { ok: true }
      },
      laneFor: () => 'gesture',
      send: vi.fn()
    })

    controller.beginTurn('Walk me through it.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-planner', 'focus'))
    await controller.responseDone('response-1')
    expect(executed).toEqual(['focus'])

    // Beat two: explanation AND the next focus in one response.
    controller.responseCreated('response-2')
    controller.assistantTranscriptDone('response-2', 'The Planner decides what happens next.')
    controller.functionCallDone(call('response-2', 'call-executor', 'focus'))
    const completing = controller.responseDone('response-2')

    controller.assistantAudioEnded()
    await completing

    expect(executed).toEqual(['focus', 'focus'])
    expect(controller.activeTurn()?.executions.at(-1)).toMatchObject({
      callId: 'call-executor',
      status: 'success'
    })
  })

  it('forces a final no-tool response when the round budget is exhausted', async () => {
    const sent: Record<string, unknown>[] = []

    const controller = createRealtimeTurnController({
      execute: async ({ name }) => ({ ok: name }),
      maxToolRounds: 2,
      send: event => sent.push(event)
    })

    controller.beginTurn('Search, inspect, and answer.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-1', 'web_search'))
    await controller.responseDone('response-1')
    controller.responseCreated('response-2')
    controller.functionCallDone(call('response-2', 'call-2', 'session_snapshot'))
    await controller.responseDone('response-2')

    const continuations = sent.filter(event => event.type === 'response.create')

    expect(continuations).toHaveLength(2)
    expect(continuations[0]).not.toHaveProperty('response.tool_choice')
    expect(continuations[1]).toMatchObject({
      response: {
        instructions: expect.stringMatching(/no tool rounds remain/i),
        tool_choice: 'none'
      }
    })
  })

  it('cancels pending calls on barge-in and drops their late results', async () => {
    const work = deferred<unknown>()
    const sent: Record<string, unknown>[] = []
    const execute = vi.fn(() => work.promise)
    const controller = createRealtimeTurnController({ execute, send: event => sent.push(event) })

    controller.beginTurn('Search for the latest information.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-search', 'web_search'))
    const completing = controller.responseDone('response-1')
    await vi.waitFor(() => expect(execute).toHaveBeenCalled())

    controller.interrupt()
    work.resolve({ data: 'late result' })
    await completing

    const outputs = sent.filter(event => event.type === 'conversation.item.create')

    expect(outputs).toHaveLength(1)
    expect(JSON.parse((outputs[0].item as { output: string }).output)).toEqual({ cancelled: true })
    expect(sent.some(event => event.type === 'response.create')).toBe(false)
    expect(controller.activeTurn()).toBeNull()
  })

  it('does not let stale response completion settle the next user turn', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const controller = createRealtimeTurnController({ execute, send: vi.fn() })

    controller.beginTurn('Turn A')
    controller.responseCreated('response-a')
    controller.interrupt()

    const turnB = controller.beginTurn('Turn B')
    controller.responseCreated('response-b')

    await expect(controller.responseDone('response-a')).resolves.toEqual({
      continued: false,
      settled: false
    })
    expect(controller.activeTurn()?.id).toBe(turnB)

    controller.functionCallDone(call('response-b', 'call-b', 'session_snapshot'))
    await expect(controller.responseDone('response-b')).resolves.toEqual({
      continued: true,
      settled: false
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('does not execute calls from a cancelled provider response', async () => {
    const execute = vi.fn(async () => ({ shouldNot: 'run' }))
    const send = vi.fn()
    const controller = createRealtimeTurnController({ execute, send })

    controller.beginTurn('Cancelled request')
    controller.responseCreated('response-cancelled')
    controller.functionCallDone(
      call('response-cancelled', 'call-cancelled', 'web_search')
    )

    await expect(controller.responseDone('response-cancelled', 'cancelled')).resolves.toEqual({
      continued: false,
      settled: true
    })
    expect(execute).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(controller.activeTurn()).toBeNull()
  })

  it('freezes the call set when response completion begins', async () => {
    const first = deferred<unknown>()

    const execute = vi.fn(({ callId }: { callId: string }) =>
      callId === 'call-first' ? first.promise : Promise.resolve({ late: true })
    )

    const send = vi.fn()
    const controller = createRealtimeTurnController({ execute, send })

    controller.beginTurn('One closed response batch')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-first', 'web_search'))
    const completing = controller.responseDone('response-1')
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())

    controller.functionCallDone(call('response-1', 'call-late', 'session_snapshot'))
    first.resolve({ first: true })
    await completing

    expect(execute).toHaveBeenCalledOnce()
    expect(
      send.mock.calls.filter(([event]) => event.type === 'conversation.item.create')
    ).toHaveLength(1)
    expect(send.mock.calls.filter(([event]) => event.type === 'response.create')).toHaveLength(1)
  })

  it('bounds a stalled tool by the remaining semantic-turn deadline', async () => {
    vi.useFakeTimers()
    const sent: Record<string, unknown>[] = []

    const controller = createRealtimeTurnController({
      execute: () => new Promise(() => undefined),
      laneFor: () => 'read',
      maxTurnMs: 1_000,
      send: event => sent.push(event)
    })

    controller.beginTurn('Search, but do not hang forever.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-search', 'web_search'))
    const completing = controller.responseDone('response-1')

    await vi.advanceTimersByTimeAsync(1_000)
    await completing

    const output = sent.find(event => event.type === 'conversation.item.create')

    expect(JSON.parse((output?.item as { output: string }).output)).toEqual({
      error: 'Voice tool timed out'
    })
    expect(sent.at(-1)).toMatchObject({ response: { tool_choice: 'none' }, type: 'response.create' })
    vi.useRealTimers()
  })

  it('bounds a missing playback-ended event by the semantic-turn deadline', async () => {
    vi.useFakeTimers()
    const sent: Record<string, unknown>[] = []
    const execute = vi.fn(async () => ({ focused: true }))

    const controller = createRealtimeTurnController({
      execute,
      laneFor: () => 'gesture',
      maxTurnMs: 1_000,
      send: event => sent.push(event)
    })

    controller.beginTurn('Explain one node, then move to the next.')
    controller.responseCreated('response-1')
    controller.assistantAudioStarted()
    controller.assistantTranscriptDone('response-1', 'The first node controls planning.')
    controller.functionCallDone(call('response-1', 'call-next-focus', 'focus'))
    const completing = controller.responseDone('response-1')

    await vi.advanceTimersByTimeAsync(1_000)
    await completing

    expect(execute).not.toHaveBeenCalled()
    const output = sent.find(event => event.type === 'conversation.item.create')
    expect(JSON.parse((output?.item as { output: string }).output)).toEqual({
      error: 'Voice playback boundary timed out'
    })
    expect(sent.at(-1)).toMatchObject({ response: { tool_choice: 'none' }, type: 'response.create' })
    vi.useRealTimers()
  })

  it('does not start another action after the turn deadline has elapsed', async () => {
    let now = 0

    const execute = vi.fn(async () => {
      now = 1_000

      return { ok: true }
    })

    const send = vi.fn()

    const controller = createRealtimeTurnController({
      execute,
      maxTurnMs: 1_000,
      now: () => now,
      send
    })

    controller.beginTurn('Use at most the remaining time.')
    controller.responseCreated('response-1')
    controller.functionCallDone(call('response-1', 'call-1', 'rename'))
    controller.functionCallDone(call('response-1', 'call-2', 'connect'))
    await controller.responseDone('response-1')

    expect(execute).toHaveBeenCalledOnce()

    const outputs = send.mock.calls
      .filter(([event]) => event.type === 'conversation.item.create')
      .map(([event]) => JSON.parse(event.item.output))

    expect(outputs).toEqual([{ ok: true }, { error: 'Voice tool timed out' }])
  })
})
