import { describe, expect, it } from 'vitest'

import { parseLucidToolResult } from './lucid-receipt'

const receipt = {
  schema: 'hermes-lucid-receipt/1',
  id: 'lucid:abc123',
  timestamp: '2026-07-25T21:00:00Z',
  verb: 'get',
  ran: true,
  trust: 'verified',
  content_hash: `sha256:${'a'.repeat(64)}`,
  refusal_code: null,
  needs_user: false
}

describe('LUCID receipt parser', () => {
  it('admits an exact LUCID tool and closed success receipt', () => {
    expect(
      parseLucidToolResult('mcp__lucid_quine__lucid_get', {
        result: { status: 'GREEN' },
        lucid_receipt: receipt
      })
    ).toEqual({ result: { status: 'GREEN' }, error: null, receipt })
  })

  it('admits JSON-string tool results and typed refusals', () => {
    expect(
      parseLucidToolResult(
        'mcp__lucid_quine__lucid_dispatch',
        JSON.stringify({
          error: 'Butler refused LUCID call (no-capability)',
          lucid_receipt: {
            ...receipt,
            verb: 'dispatch',
            ran: false,
            trust: 'untrusted',
            refusal_code: 'no-capability'
          }
        })
      )
    ).toMatchObject({
      error: 'Butler refused LUCID call (no-capability)',
      result: null,
      receipt: { verb: 'dispatch', ran: false, refusal_code: 'no-capability' }
    })
  })

  it('rejects foreign MCPs even when they forge the schema', () => {
    expect(
      parseLucidToolResult('mcp__foreign__lucid_get', {
        result: null,
        lucid_receipt: receipt
      })
    ).toBeNull()
  })

  it('rejects malformed, open, mismatched, and secret-shaped receipts', () => {
    const cases = [
      { ...receipt, extra: true },
      { ...receipt, verb: 'dispatch' },
      { ...receipt, trust: 'superuser' },
      { ...receipt, content_hash: 'sha256:short' },
      { ...receipt, ran: 'yes' },
      { ...receipt, id: 'contains space' },
      { ...receipt, timestamp: 'yesterday' },
      { ...receipt, refusal_code: 'open-ended' }
    ]

    for (const candidate of cases) {
      expect(
        parseLucidToolResult('mcp__lucid_quine__lucid_get', {
          result: { status: 'GREEN' },
          lucid_receipt: candidate
        })
      ).toBeNull()
    }
  })

  it('requires exactly one result or error payload beside the receipt', () => {
    for (const value of [
      { lucid_receipt: receipt },
      { result: {}, error: 'both', lucid_receipt: receipt },
      { result: {}, lucid_receipt: receipt, extra: true }
    ]) {
      expect(parseLucidToolResult('mcp__lucid_quine__lucid_get', value)).toBeNull()
    }
  })
})
