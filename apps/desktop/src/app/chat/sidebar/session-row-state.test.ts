import { describe, expect, it } from 'vitest'

import { type SessionDotState, sessionDotState, sessionShowsRunningArc } from './session-row-state'

/** Only the flags a case cares about need naming. */
const state = (over: Partial<Parameters<typeof sessionDotState>[0]> = {}): SessionDotState =>
  sessionDotState({
    hasBackground: false,
    hasError: false,
    hasSubagents: false,
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

    for (let mask = 0; mask < 64; mask += 1) {
      const resolved = state({
        hasBackground: Boolean(mask & 1),
        hasError: Boolean(mask & 2),
        hasSubagents: Boolean(mask & 32),
        isStalled: Boolean(mask & 4),
        isUnread: Boolean(mask & 8),
        isWorking: Boolean(mask & 16),
        needsInput: false
      })

      expect(resolved).toBeTruthy()
      seen.add(resolved)
    }

    expect(seen).toEqual(new Set(['background', 'error', 'idle', 'stalled', 'subagent', 'unread', 'working']))
  })
})

describe('running arc stays in lockstep with the dot', () => {
  // The reported symptom: the shimmer "sometimes doesn't show up". A row must
  // never render a working/stalled dot with no arc — they read the same signals
  // and are the same claim ("this session is running") in two places.
  const dotSaysRunning = (s: SessionDotState) => s === 'working' || s === 'stalled' || s === 'subagent'

  it('shows the arc for every state the dot calls running', () => {
    for (let mask = 0; mask < 16; mask += 1) {
      const flags = {
        hasBackground: Boolean(mask & 1),
        hasError: Boolean(mask & 2),
        hasSubagents: Boolean(mask & 8),
        isStalled: Boolean(mask & 4),
        isUnread: false,
        isWorking: true,
        needsInput: false
      }

      expect(sessionShowsRunningArc(flags)).toBe(dotSaysRunning(sessionDotState(flags)))
    }
  })

  it('keeps the arc through a stall', () => {
    // A quiet turn is still running; dropping the arc during a long tool call
    // is what made the shimmer look intermittent.
    expect(sessionShowsRunningArc({ isWorking: true, needsInput: false })).toBe(true)
    expect(state({ isStalled: true, isWorking: true })).toBe('stalled')
  })

  it('hides both when a prompt blocks the turn', () => {
    expect(sessionShowsRunningArc({ isWorking: true, needsInput: true })).toBe(false)
    expect(state({ isWorking: true, needsInput: true })).toBe('needs-input')
  })

  it('shows no arc when nothing is running', () => {
    expect(sessionShowsRunningArc({ isWorking: false, needsInput: false })).toBe(false)
  })
})

describe('subagent state', () => {
  it('shows the subagent dot while delegated work is in flight', () => {
    expect(state({ hasSubagents: true, isWorking: true })).toBe('subagent')
  })

  it('outranks plain working — it is the more specific signal', () => {
    // Both mean "running"; only one says the wait is fan-out.
    expect(state({ hasSubagents: true, isStalled: true, isWorking: true })).toBe('subagent')
  })

  it('yields to error and needs-input', () => {
    // A failure or a blocking prompt must never be masked by delegated work.
    expect(state({ hasError: true, hasSubagents: true, isWorking: true })).toBe('error')
    expect(state({ hasSubagents: true, isWorking: true, needsInput: true })).toBe('needs-input')
  })

  it('does not fire when the turn is not running', () => {
    // Stale subagent rows must not paint a live-looking dot on an idle session.
    expect(state({ hasSubagents: true })).toBe('idle')
    expect(state({ hasBackground: true, hasSubagents: true })).toBe('background')
  })

  it('is distinct from the background-process dot', () => {
    // Grey background = detached process while the turn is IDLE. Pink subagent
    // = the turn is running and waiting on delegation. Different situations.
    expect(state({ hasBackground: true })).toBe('background')
    expect(state({ hasSubagents: true, isWorking: true })).toBe('subagent')
  })
})
