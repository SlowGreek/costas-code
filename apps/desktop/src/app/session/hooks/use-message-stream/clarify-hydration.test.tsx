import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $clarifyRequests, clearClarifyRequest } from '@/store/clarify'
import { onScrollToBottomRequest } from '@/store/thread-scroll'

import { type MessageStreamHarness, renderMessageStream } from './test-harness'

// A `clarify.request` must leave an answerable inline row even when the
// `tool.start` that normally mounts it was missed (stream reconnect /
// hydration race). Without it the sidebar says "needs input" but the
// transcript has nowhere to render the choices, so the agent blocks forever.

const SID = 'session-1'

let stream: MessageStreamHarness
let stopScrollListener: (() => void) | null = null

const scrollToBottom = vi.fn()

function mountStream() {
  stream = renderMessageStream(SID)
}

const clarifyRequest = (payload: Record<string, unknown>) =>
  act(() => stream.handleEvent({ payload, session_id: SID, type: 'clarify.request' }))

const clarifyExpire = (payload: Record<string, unknown>) =>
  act(() => stream.handleEvent({ payload, session_id: SID, type: 'clarify.expire' }))

const toolStart = (payload: Record<string, unknown>) =>
  act(() => stream.handleEvent({ payload, session_id: SID, type: 'tool.start' }))

function clarifyParts() {
  const messages = stream.state().messages ?? []

  return messages.flatMap(m => m.parts).filter(p => p.type === 'tool-call' && p.toolName === 'clarify')
}

describe('clarify.request stream hydration', () => {
  beforeEach(() => {
    clearClarifyRequest()
    scrollToBottom.mockClear()
    stopScrollListener = onScrollToBottomRequest(scrollToBottom)
  })

  afterEach(() => {
    cleanup()
    clearClarifyRequest()
    stopScrollListener?.()
    stopScrollListener = null
    vi.restoreAllMocks()
  })

  it('mounts an answerable clarify row when the tool.start row was missed', () => {
    mountStream()

    clarifyRequest({ choices: ['yes', 'no'], question: 'Ship it?', request_id: 'req-1' })

    const parts = clarifyParts()
    expect(parts).toHaveLength(1)
    expect(parts[0].type === 'tool-call' && parts[0].toolCallId).toBe('req-1')
    expect(parts[0].type === 'tool-call' && parts[0].args).toMatchObject({
      choices: ['yes', 'no'],
      question: 'Ship it?'
    })
  })

  it('reveals a clarify prompt raised by the active session', () => {
    mountStream()

    clarifyRequest({ choices: ['yes', 'no'], question: 'Ship it?', request_id: 'req-reveal' })

    expect(scrollToBottom).toHaveBeenCalledOnce()
  })

  it('does not move the active thread for a background session clarify', () => {
    mountStream()

    act(() =>
      stream.handleEvent({
        payload: { choices: ['yes', 'no'], question: 'Ship it?', request_id: 'req-background' },
        session_id: 'session-background',
        type: 'clarify.request'
      })
    )

    expect(scrollToBottom).not.toHaveBeenCalled()
  })

  it('preserves multi-select through the store and hydrated tool row', () => {
    mountStream()

    clarifyRequest({
      choices: ['read', 'write'],
      multi_select: true,
      question: 'Which permissions?',
      request_id: 'req-multi'
    })

    expect($clarifyRequests.get()[SID]?.multiSelect).toBe(true)

    const part = clarifyParts()[0]
    expect(part?.type).toBe('tool-call')

    if (part?.type !== 'tool-call') {
      throw new Error('Expected a hydrated clarify tool call')
    }

    expect(part.args).toMatchObject({
      choices: ['read', 'write'],
      multi_select: true,
      question: 'Which permissions?'
    })
  })

  it('merges with the real tool.start row even though its id differs from the request id', () => {
    mountStream()

    // Reality: tool.start carries the model's tool_call_id, clarify.request a
    // separately-generated request_id. They must still collapse to ONE card
    // (correlated by question), not two.
    toolStart({ args: { choices: ['a'], question: 'Pick' }, name: 'clarify', tool_id: 'call-abc' })
    clarifyRequest({ choices: ['a'], question: 'Pick', request_id: 'req-2' })

    expect(clarifyParts()).toHaveLength(1)
  })

  it('drops the live request and the needs-input flag when the clarify expires', () => {
    mountStream()

    clarifyRequest({ choices: ['a'], question: 'Pick', request_id: 'req-exp' })

    expect($clarifyRequests.get()[SID]).toBeTruthy()
    expect(stream.state().needsInput).toBe(true)

    // The server-side wait elapsed: the request is gone from the gateway's
    // `_pending`, so the card must stop pretending to be answerable.
    clarifyExpire({ request_id: 'req-exp' })

    expect($clarifyRequests.get()[SID]).toBeUndefined()
    expect(stream.state().needsInput).toBe(false)
  })

  it('leaves a newer clarify alone when a stale expire arrives', () => {
    mountStream()

    clarifyRequest({ choices: ['a'], question: 'Pick', request_id: 'req-new' })
    clarifyExpire({ request_id: 'req-old' })

    expect($clarifyRequests.get()[SID]?.requestId).toBe('req-new')
    // The session is still blocked on the newer question, so the sidebar's
    // attention indicator must survive a no-op expire.
    expect(stream.state().needsInput).toBe(true)
  })

  it('does not duplicate when clarify.request arrives before the tool.start row', () => {
    mountStream()

    clarifyRequest({ choices: ['a'], question: 'Pick', request_id: 'req-3' })
    toolStart({ args: { choices: ['a'], question: 'Pick' }, name: 'clarify', tool_id: 'call-xyz' })

    expect(clarifyParts()).toHaveLength(1)
  })

  it('merges a BATCH tool.start row with its clarify.request (no top-level question)', () => {
    mountStream()

    // The batch shape: tool args carry `questions`, no top-level `question`.
    // The correlation key must come from the question list, or the two ids
    // mount two cards (the duplicate seen in the field).
    toolStart({
      args: { questions: [{ question: 'Drink?' }, { question: 'Productive when?' }] },
      name: 'clarify',
      tool_id: 'call-batch'
    })
    clarifyRequest({
      questions: [
        { qid: 'q0', question: 'Drink?' },
        { qid: 'q1', question: 'Productive when?' }
      ],
      request_id: 'req-batch'
    })

    expect(clarifyParts()).toHaveLength(1)
    expect($clarifyRequests.get()[SID]?.questions).toHaveLength(2)
  })

  it('does not duplicate when the batch clarify.request arrives before tool.start', () => {
    mountStream()

    clarifyRequest({
      questions: [
        { qid: 'q0', question: 'Drink?' },
        { qid: 'q1', question: 'Productive when?' }
      ],
      request_id: 'req-batch-2'
    })
    toolStart({
      args: { questions: [{ question: 'Drink?' }, { question: 'Productive when?' }] },
      name: 'clarify',
      tool_id: 'call-batch-2'
    })

    expect(clarifyParts()).toHaveLength(1)
    expect($clarifyRequests.get()[SID]?.questions).toHaveLength(2)
  })
})
