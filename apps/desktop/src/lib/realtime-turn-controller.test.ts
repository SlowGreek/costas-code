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

  it('correlates child events without response ids to the current response', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const send = vi.fn()
    const controller = createRealtimeTurnController({ execute, send })

    controller.beginTurn('Inspect the canvas.')
    controller.responseCreated('')
    controller.functionCallDone(call('', 'call-1', 'session_snapshot'))
    const outcome = await controller.responseDone('')

    expect(execute).toHaveBeenCalledOnce()
    expect(outcome).toEqual({ continued: true, settled: false })
    expect(send.mock.calls.filter(([event]) => event.type === 'response.create')).toHaveLength(1)
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

  it('bounds a stalled tool by the remaining semantic-turn deadline', async () => {
    vi.useFakeTimers()
    const sent: Record<string, unknown>[] = []

    const controller = createRealtimeTurnController({
      execute: () => new Promise(() => undefined),
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
})
