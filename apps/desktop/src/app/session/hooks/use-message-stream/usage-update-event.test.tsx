import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

/**
 * The status bar's token counter used to freeze for the whole of a long turn.
 *
 * `session.info` is only emitted from the backend's turn-end `finally` block,
 * so a turn with twenty tool calls showed the count it had BEFORE the turn
 * started and then jumped at the end. The backend now emits a lightweight
 * `usage.update` after every tool call; these pin that the desktop applies it
 * to both the per-session twin (what the statusbar reads for focused tiles)
 * and the active-session mirror.
 */

const SID = 'session-1'
let handleEvent: ((event: RpcEvent) => void) | null = null
let states: Map<string, ClientSessionState>

function Harness() {
  const activeSessionIdRef = useRef<string | null>(SID)
  const sessionStateByRuntimeIdRef = useRef(new Map<string, ClientSessionState>())
  const queryClientRef = useRef(new QueryClient())

  states = sessionStateByRuntimeIdRef.current

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
  }, [stream.handleGatewayEvent])

  return null
}

async function mountStream() {
  render(<Harness />)
  await waitFor(() => expect(handleEvent).not.toBeNull())
}

function emit(type: RpcEvent['type'], payload: RpcEvent['payload'] = {}, sessionId = SID) {
  act(() => handleEvent!({ payload, session_id: sessionId, type }))
}

describe('useMessageStream usage.update', () => {
  beforeEach(() => {
    handleEvent = null
  })

  afterEach(() => {
    cleanup()
    handleEvent = null
  })

  it('applies a mid-turn usage snapshot to the per-session twin', async () => {
    await mountStream()

    emit('usage.update' as RpcEvent['type'], {
      usage: { calls: 3, context_percent: 42, context_used: 84_000, input: 84_000, total: 90_000 }
    })

    expect(states.get(SID)?.usage).toMatchObject({
      calls: 3,
      context_percent: 42,
      context_used: 84_000,
      input: 84_000,
      total: 90_000
    })
  })

  it('merges successive snapshots rather than replacing them', async () => {
    await mountStream()

    emit('usage.update' as RpcEvent['type'], { usage: { calls: 1, input: 1_000, total: 1_200 } })
    emit('usage.update' as RpcEvent['type'], { usage: { calls: 2, input: 5_000, total: 5_400 } })

    // A later snapshot wins on the keys it carries — the counter climbs during
    // the turn instead of resetting.
    expect(states.get(SID)?.usage).toMatchObject({ calls: 2, input: 5_000, total: 5_400 })
  })

  it('preserves keys a partial snapshot omits', async () => {
    await mountStream()

    emit('usage.update' as RpcEvent['type'], {
      usage: { calls: 1, context_max: 200_000, input: 1_000, total: 1_200 }
    })
    emit('usage.update' as RpcEvent['type'], { usage: { input: 2_000 } })

    // context_max is only reported when a compressor exists; a snapshot without
    // it must not blank the gauge's denominator.
    expect(states.get(SID)?.usage).toMatchObject({ context_max: 200_000, input: 2_000 })
  })

  it('ignores an event with no usage payload', async () => {
    await mountStream()

    emit('usage.update' as RpcEvent['type'], { usage: { input: 7_000 } })
    emit('usage.update' as RpcEvent['type'], {})

    expect(states.get(SID)?.usage).toMatchObject({ input: 7_000 })
  })

  it('routes a background session usage to that session only', async () => {
    await mountStream()

    emit('usage.update' as RpcEvent['type'], { usage: { input: 111 } }, 'session-2')

    // The focused session must not adopt a background tile's count.
    expect(states.get('session-2')?.usage).toMatchObject({ input: 111 })
    expect(states.get(SID)?.usage?.input ?? 0).toBe(0)
  })
})
