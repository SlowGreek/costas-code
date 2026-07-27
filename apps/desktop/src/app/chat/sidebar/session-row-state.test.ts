import { describe, expect, it } from 'vitest'

import { type SessionDotState, sessionDotState, sessionShowsRunningArc } from './session-row-state'

/** Only the flags a case cares about need naming. */
const state = (over: Partial<Parameters<typeof sessionDotState>[0]> = {}): SessionDotState =>
  sessionDotState({
    hasBackground: false,
    hasError: false,
    isStalled: false,
    isUnread: false,
    isWorking: false,
    needsInput: false,
    ...over
  })

describe('session row running appearance', () => {
  it('keeps the running arc when an authoritative turn becomes quiet', () => {
    expect(sessionShowsRunningArc({ isWorking: true, needsInput: false })).toBe(true)
    expect(state({ isStalled: true, isWorking: true })).toBe('stalled')
  })

  it('uses the needs-input treatment instead of the running arc', () => {
    expect(sessionShowsRunningArc({ isWorking: true, needsInput: true })).toBe(false)
    expect(
      state({ hasBackground: true, isStalled: true, isUnread: true, isWorking: true, needsInput: true })
    ).toBe('needs-input')
  })

  it('keeps background and unread states below active-turn states', () => {
    expect(state({ hasBackground: true, isUnread: true })).toBe('background')
  })
})

describe('error state', () => {
  it('shows the error dot when the last turn failed', () => {
    expect(state({ hasError: true })).toBe('error')
  })

  it('outranks working, background and unread', () => {
    // A failed turn is the thing the user needs to know about; a stale
    // "working" pulse on a dead turn is actively misleading.
    expect(state({ hasBackground: true, hasError: true, isUnread: true, isWorking: true })).toBe('error')
  })

  it('yields to needs-input', () => {
    // A blocking prompt is actionable right now; the error is already over.
    expect(state({ hasError: true, needsInput: true })).toBe('needs-input')
  })

  it('does not appear when no error is recorded', () => {
    expect(state({ isWorking: true })).toBe('working')
    expect(state({ isUnread: true })).toBe('unread')
    expect(state()).toBe('idle')
  })
})

describe('state priority is total', () => {
  it('assigns exactly one state for every flag combination', () => {
    // Every dot state must be reachable and unambiguous — a combination that
    // resolved to nothing would render an idle dot on a live session.
    const seen = new Set<SessionDotState>()

    for (let mask = 0; mask < 32; mask += 1) {
      const resolved = state({
        hasBackground: Boolean(mask & 1),
        hasError: Boolean(mask & 2),
        isStalled: Boolean(mask & 4),
        isUnread: Boolean(mask & 8),
        isWorking: Boolean(mask & 16),
        needsInput: false
      })

      expect(resolved).toBeTruthy()
      seen.add(resolved)
    }

    expect(seen).toEqual(new Set(['background', 'error', 'idle', 'stalled', 'unread', 'working']))
  })
})
