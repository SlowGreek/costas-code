import { afterEach, describe, expect, it, vi } from 'vitest'

import { $clarifyRequests, clearClarifyRequest, rearmPendingPrompts } from './clarify'

afterEach(() => {
  clearClarifyRequest()
  vi.restoreAllMocks()
})

const parked = (sessionId: string) => Boolean($clarifyRequests.get()[sessionId])

const clarifyPrompt = (payload: Record<string, unknown>) => ({ event: 'clarify.request', payload })

describe('rearmPendingPrompts', () => {
  it('restores a clarify the window never saw announced', () => {
    rearmPendingPrompts(
      'session-1',
      [clarifyPrompt({ choices: ['a', 'b'], question: 'Ship it?', request_id: 'req-1' })]
    )

    const restored = $clarifyRequests.get()['session-1']

    expect(restored).toMatchObject({
      choices: ['a', 'b'],
      question: 'Ship it?',
      requestId: 'req-1',
      sessionId: 'session-1'
    })
  })

  it('is a no-op for an empty or absent list', () => {
    rearmPendingPrompts('session-1', undefined)
    rearmPendingPrompts('session-1', [])

    expect(parked('session-1')).toBe(false)
  })

  it('ignores blocking prompts it does not own', () => {
    rearmPendingPrompts('session-1', [
      { event: 'sudo.request', payload: { question: 'password?', request_id: 'req-sudo' } },
      { event: 'secret.request', payload: { question: 'token?', request_id: 'req-secret' } }
    ])

    expect(parked('session-1')).toBe(false)
  })

  it('skips a payload missing the request id or question — an unanswerable card is worse than none', () => {
    rearmPendingPrompts('session-1', [
      clarifyPrompt({ question: 'no id', request_id: '' }),
      clarifyPrompt({ question: '', request_id: 'req-2' })
    ])

    expect(parked('session-1')).toBe(false)
  })

  it('falls back to free text when every choice normalizes away', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    rearmPendingPrompts('session-1', [clarifyPrompt({ choices: ['', '   '], question: 'Ship it?', request_id: 'req-3' })])

    expect($clarifyRequests.get()['session-1'].choices).toBeNull()
  })
})
