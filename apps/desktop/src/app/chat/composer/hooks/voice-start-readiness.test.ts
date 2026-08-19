import { describe, expect, it } from 'vitest'

import { voiceStartReadiness } from './voice-start-readiness'

/**
 * Hitting the mic on a brand-new chat reported:
 *
 *   "Could not start voice session
 *    Hermes gateway session is not ready for GPT Realtime"
 *
 * A new chat has no runtime session until the first message creates one, so
 * the guard fired and killed the attempt. Two things were wrong: the attempt
 * was discarded rather than parked, and the message named an internal concept
 * the user cannot act on.
 */
describe('voiceStartReadiness', () => {
  it('is ready when the gateway and a session are both present', () => {
    expect(voiceStartReadiness({ hasGateway: true, sessionId: 'runtime-1' })).toEqual({
      kind: 'ready'
    })
  })

  it('waits — rather than failing — when the chat has no session yet', () => {
    // The overwhelmingly common case: a new chat where the user reaches for
    // the mic before typing anything.
    expect(voiceStartReadiness({ hasGateway: true, sessionId: null })).toEqual({
      kind: 'wait-for-session'
    })
  })

  it('fails when the gateway itself is missing', () => {
    // Genuinely broken: the backend is not connected, and no amount of waiting
    // for a session will help.
    const result = voiceStartReadiness({ hasGateway: false, sessionId: 'runtime-1' })

    expect(result.kind).toBe('fail')
  })

  it('treats a disconnected gateway as the failure even with no session', () => {
    const result = voiceStartReadiness({ hasGateway: false, sessionId: null })

    expect(result.kind).toBe('fail')
  })

  it('explains the failure in terms the user can act on', () => {
    const result = voiceStartReadiness({ hasGateway: false, sessionId: null })

    if (result.kind !== 'fail') {
      throw new Error('expected a failure')
    }

    // "Hermes gateway session is not ready for GPT Realtime" describes our
    // internals. The user needs to know what to DO.
    expect(result.reason).not.toMatch(/gateway session is not ready/i)
    expect(result.reason).toMatch(/connect|reconnect|not connected/i)
  })
})
