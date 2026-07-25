// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LucidReceiptCard } from './lucid-receipt-card'
import { LucidSafetyStateCard } from './lucid-safety-state-card'

const success = {
  result: { status: 'GREEN', rows: 2 },
  error: null,
  receipt: {
    schema: 'hermes-lucid-receipt/1' as const,
    id: 'lucid:abc123',
    timestamp: '2026-07-25T21:00:00Z',
    verb: 'get' as const,
    ran: true,
    trust: 'verified' as const,
    content_hash: `sha256:${'a'.repeat(64)}`,
    refusal_code: null,
    needs_user: false
  }
}

describe('LUCID receipt card', () => {
  it('renders a first-class successful receipt and intended result', () => {
    render(<LucidReceiptCard value={success} />)

    expect(screen.getByRole('region', { name: 'LUCID receipt' })).toBeTruthy()
    expect(screen.getByText('LUCID · GET')).toBeTruthy()
    expect(screen.getByText('Executed')).toBeTruthy()
    expect(screen.getByText('verified')).toBeTruthy()
    expect(screen.getByText(/GREEN/)).toBeTruthy()
    expect(screen.queryByText(/capability/)).toBeNull()
  })

  it('renders refusal posture without claiming execution', () => {
    render(
      <LucidReceiptCard
        value={{
          result: null,
          error: 'Butler refused LUCID call (no-capability)',
          receipt: {
            ...success.receipt,
            verb: 'dispatch',
            ran: false,
            trust: 'untrusted',
            refusal_code: 'no-capability'
          }
        }}
      />
    )

    expect(screen.getByText('LUCID · DISPATCH')).toBeTruthy()
    expect(screen.getByText('Refused · not run')).toBeTruthy()
    expect(screen.getByText('no-capability')).toBeTruthy()
    expect(screen.queryByText('Executed')).toBeNull()
  })

  it('renders explicit user-attention posture', () => {
    render(
      <LucidReceiptCard
        value={{
          ...success,
          receipt: { ...success.receipt, ran: false, needs_user: true }
        }}
      />
    )

    expect(screen.getByText('Needs user · not run')).toBeTruthy()
  })
})

describe('LUCID safety-state card', () => {
  it('renders outcome ambiguity without claiming execution or retryability', () => {
    render(
      <LucidSafetyStateCard
        value={{
          code: 'lucid-outcome-unknown',
          message: 'LUCID call outcome is unknown; automatic retry is disabled',
          verb: 'dispatch'
        }}
      />
    )

    expect(screen.getByRole('alert', { name: 'LUCID safety state' })).toBeTruthy()
    expect(screen.getByText('LUCID · DISPATCH')).toBeTruthy()
    expect(screen.getByText('Outcome unknown')).toBeTruthy()
    expect(screen.getByText('Do not retry automatically')).toBeTruthy()
    expect(screen.queryByText('Executed')).toBeNull()
  })

  it('renders invalid receipt as a protocol failure, not a Butler refusal', () => {
    render(
      <LucidSafetyStateCard
        value={{
          code: 'lucid-invalid-receipt',
          message: 'Butler returned an invalid LUCID refusal receipt',
          verb: 'get'
        }}
      />
    )

    expect(screen.getByText('Invalid receipt')).toBeTruthy()
    expect(screen.getByText('Butler returned an invalid LUCID refusal receipt')).toBeTruthy()
    expect(screen.queryByText('Refused · not run')).toBeNull()
  })
})
