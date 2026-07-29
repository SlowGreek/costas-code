import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearClarifyRequest, setClarifyRequest } from '@/store/clarify'
import { $gateway } from '@/store/gateway'
import { $activeSessionId } from '@/store/session'

import { clarifyRequestMatchesRow, ClarifyTool } from './clarify-tool'

// The turn is NOT running — the state a `session.resume` leaves behind while a
// clarify is still parked on the session (resume sets busy true on entry, then
// back to the resumed `running`, which the deferred-resume path reports as
// false). The card must survive that.
vi.mock('@assistant-ui/react', () => ({
  useAuiState: () => false
}))

afterEach(() => {
  cleanup()
  clearClarifyRequest()
  $activeSessionId.set(null)
  $gateway.set(null)
  vi.clearAllMocks()
})

function renderClarify(ui: ReactNode) {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      {ui}
    </I18nProvider>
  )
}

function clarifyProps(): ToolCallMessagePartProps {
  const args = { choices: ['staging', 'production'], question: 'Which deployment target?' }

  return {
    addResult: vi.fn(),
    args,
    argsText: JSON.stringify(args),
    isError: false,
    respondToApproval: vi.fn(),
    result: undefined,
    resume: vi.fn(),
    status: { type: 'running' },
    toolCallId: 'clarify-live',
    toolName: 'clarify',
    type: 'tool-call'
  }
}

describe('ClarifyTool lifetime is owned by the request, not the running turn', () => {
  it('stays answerable while a request is parked even though the turn reads not-running', () => {
    $activeSessionId.set('session-1')
    $gateway.set({ request: vi.fn().mockResolvedValue({ ok: true }) } as never)
    setClarifyRequest({
      choices: ['staging', 'production'],
      question: 'Which deployment target?',
      requestId: 'req-live',
      sessionId: 'session-1'
    })

    renderClarify(<ClarifyTool {...clarifyProps()} />)

    // The interactive panel, not the inert ToolFallback row.
    expect(screen.getByText('Which deployment target?')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /staging/ }).length).toBeGreaterThan(0)
  })

  it('falls back to the inert row once the request is gone and the turn is not running', () => {
    $activeSessionId.set('session-1')

    renderClarify(<ClarifyTool {...clarifyProps()} />)

    // No live request → nothing to answer with; the panel must not offer
    // choices that can no longer resolve anything.
    expect(screen.queryByRole('button', { name: /staging/ })).toBeNull()
  })

  it('ignores a request parked on a different session', () => {
    $activeSessionId.set('session-1')
    setClarifyRequest({
      choices: ['staging', 'production'],
      question: 'Which deployment target?',
      requestId: 'req-other',
      sessionId: 'session-2'
    })

    renderClarify(<ClarifyTool {...clarifyProps()} />)

    expect(screen.queryByRole('button', { name: /staging/ })).toBeNull()
  })

  it('does not claim a NEWER request belonging to a different row', () => {
    // Two clarifies in one transcript: this row is the older, un-resulted one
    // (interrupted or expired), and a different question is now live. The old
    // row must settle inertly — claiming the live request would leave it stuck
    // on a spinner forever, since the pending panel rejects the mismatch.
    $activeSessionId.set('session-1')
    setClarifyRequest({
      choices: ['yes', 'no'],
      question: 'A completely different question?',
      requestId: 'req-new',
      sessionId: 'session-1'
    })

    const { container } = renderClarify(<ClarifyTool {...clarifyProps()} />)

    expect(screen.queryByRole('button', { name: /staging/ })).toBeNull()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})

describe('clarifyRequestMatchesRow', () => {
  const request = { question: 'Which deployment target?', requestId: 'req-1' }

  it('matches on request id even when the questions differ', () => {
    // A row hydrated straight from clarify.request carries the request id as
    // its tool call id; the args may not have landed yet.
    expect(clarifyRequestMatchesRow(request, 'req-1', undefined)).toBe(true)
    expect(clarifyRequestMatchesRow(request, 'req-1', 'stale text')).toBe(true)
  })

  it('matches on question when the ids differ', () => {
    // The tool.start row carries the model's own tool_call_id, so ids never
    // line up and the question is the only correlator.
    expect(clarifyRequestMatchesRow(request, 'call-abc', 'Which deployment target?')).toBe(true)
  })

  it('rejects a different question on a different id', () => {
    expect(clarifyRequestMatchesRow(request, 'call-abc', 'Some other question?')).toBe(false)
  })

  it('rejects when there is no request at all', () => {
    expect(clarifyRequestMatchesRow(null, 'req-1', 'Which deployment target?')).toBe(false)
  })
})
