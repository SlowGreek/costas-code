import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { type MutableRefObject, useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $clarifyRequests, clearClarifyRequest } from '@/store/clarify'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

// A `clarify.request` must leave an answerable inline row even when the
// `tool.start` that normally mounts it was missed (stream reconnect /
// hydration race). Without it the sidebar says "needs input" but the
// transcript has nowhere to render the choices, so the agent blocks forever.

const SID = 'session-1'

let handleEvent: ((event: RpcEvent) => void) | null = null
let stateRef: MutableRefObject<Map<string, ClientSessionState>> | null = null

function Harness() {
  const activeSessionIdRef = useRef<string | null>(SID)
  const sessionStateByRuntimeIdRef = useRef(new Map<string, ClientSessionState>())
  const queryClientRef = useRef(new QueryClient())

  const stream = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession: vi.fn(async () => undefined),
    queryClient: queryClientRef.current,
    refreshHermesConfig: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    sessionStateByRuntimeIdRef,
    updateSessionState: (sessionId, updater) => {
      const current = sessionStateByRuntimeIdRef.current.get(sessionId) ?? createClientSessionState()
      const next = updater(current)
      sessionStateByRuntimeIdRef.current.set(sessionId, next)

      return next
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent
    stateRef = sessionStateByRuntimeIdRef
  }, [stream.handleGatewayEvent])

  return null
}

async function mountStream() {
  render(<Harness />)
  await waitFor(() => expect(handleEvent).not.toBeNull())
}

const clarifyRequest = (payload: Record<string, unknown>) =>
  act(() => handleEvent!({ payload, session_id: SID, type: 'clarify.request' }))

const clarifyExpire = (payload: Record<string, unknown>) =>
  act(() => handleEvent!({ payload, session_id: SID, type: 'clarify.expire' }))

const toolStart = (payload: Record<string, unknown>) =>
  act(() => handleEvent!({ payload, session_id: SID, type: 'tool.start' }))

function clarifyParts() {
  const messages = stateRef?.current.get(SID)?.messages ?? []

  return messages.flatMap(m => m.parts).filter(p => p.type === 'tool-call' && p.toolName === 'clarify')
}

describe('clarify.request stream hydration', () => {
  beforeEach(() => {
    handleEvent = null
    stateRef = null
    clearClarifyRequest()
  })

  afterEach(() => {
    cleanup()
    clearClarifyRequest()
    vi.restoreAllMocks()
  })

  it('mounts an answerable clarify row when the tool.start row was missed', async () => {
    await mountStream()

    clarifyRequest({ choices: ['yes', 'no'], question: 'Ship it?', request_id: 'req-1' })

    const parts = clarifyParts()
    expect(parts).toHaveLength(1)
    expect(parts[0].type === 'tool-call' && parts[0].toolCallId).toBe('req-1')
    expect(parts[0].type === 'tool-call' && parts[0].args).toMatchObject({
      choices: ['yes', 'no'],
      question: 'Ship it?'
    })
  })

  it('merges with the real tool.start row even though its id differs from the request id', async () => {
    await mountStream()

    // Reality: tool.start carries the model's tool_call_id, clarify.request a
    // separately-generated request_id. They must still collapse to ONE card
    // (correlated by question), not two.
    toolStart({ args: { choices: ['a'], question: 'Pick' }, name: 'clarify', tool_id: 'call-abc' })
    clarifyRequest({ choices: ['a'], question: 'Pick', request_id: 'req-2' })

    expect(clarifyParts()).toHaveLength(1)
  })

  it('drops the live request and the needs-input flag when the clarify expires', async () => {
    await mountStream()

    clarifyRequest({ choices: ['a'], question: 'Pick', request_id: 'req-exp' })

    expect($clarifyRequests.get()[SID]).toBeTruthy()
    expect(stateRef?.current.get(SID)?.needsInput).toBe(true)

    // The server-side wait elapsed: the request is gone from the gateway's
    // `_pending`, so the card must stop pretending to be answerable.
    clarifyExpire({ request_id: 'req-exp' })

    expect($clarifyRequests.get()[SID]).toBeUndefined()
    expect(stateRef?.current.get(SID)?.needsInput).toBe(false)
  })

  it('leaves a newer clarify alone when a stale expire arrives', async () => {
    await mountStream()

    clarifyRequest({ choices: ['a'], question: 'Pick', request_id: 'req-new' })
    clarifyExpire({ request_id: 'req-old' })

    expect($clarifyRequests.get()[SID]?.requestId).toBe('req-new')
    // The session is still blocked on the newer question, so the sidebar's
    // attention indicator must survive a no-op expire.
    expect(stateRef?.current.get(SID)?.needsInput).toBe(true)
  })

  it('does not duplicate when clarify.request arrives before the tool.start row', async () => {
    await mountStream()

    clarifyRequest({ choices: ['a'], question: 'Pick', request_id: 'req-3' })
    toolStart({ args: { choices: ['a'], question: 'Pick' }, name: 'clarify', tool_id: 'call-xyz' })

    expect(clarifyParts()).toHaveLength(1)
  })
})
