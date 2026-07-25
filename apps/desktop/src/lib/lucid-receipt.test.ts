import { describe, expect, it } from 'vitest'

import { parseLucidSafetyState, parseLucidToolResult } from './lucid-receipt'

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

describe('LUCID safety-state parser', () => {
  it('admits exact outcome-unknown posture for an effect-capable LUCID tool', () => {
    expect(
      parseLucidSafetyState('mcp__lucid_quine__lucid_dispatch', {
        error: 'LUCID call outcome is unknown; automatic retry is disabled',
        code: 'lucid-outcome-unknown',
        retryable: false,
        server: 'lucid-quine',
        tool: 'lucid.dispatch'
      })
    ).toEqual({
      code: 'lucid-outcome-unknown',
      message: 'LUCID call outcome is unknown; automatic retry is disabled',
      verb: 'dispatch'
    })
  })

  it('admits exact invalid-receipt posture without claiming a verb effect', () => {
    expect(
      parseLucidSafetyState('mcp__lucid_quine__lucid_get', {
        error: 'Butler returned an invalid LUCID refusal receipt',
        code: 'lucid-invalid-receipt',
        retryable: false
      })
    ).toEqual({
      code: 'lucid-invalid-receipt',
      message: 'Butler returned an invalid LUCID refusal receipt',
      verb: 'get'
    })
  })

  it('rejects forged, open, retryable, mismatched, and read-only outcome-unknown states', () => {
    const valid = {
      error: 'LUCID call outcome is unknown; automatic retry is disabled',
      code: 'lucid-outcome-unknown',
      retryable: false,
      server: 'lucid-quine',
      tool: 'lucid.dispatch'
    }

    const cases: Array<[string, unknown]> = [
      ['mcp__foreign__lucid_dispatch', valid],
      ['mcp__lucid_quine__lucid_get', { ...valid, tool: 'lucid.get' }],
      ['mcp__lucid_quine__lucid_dispatch', { ...valid, retryable: true }],
      ['mcp__lucid_quine__lucid_dispatch', { ...valid, server: 'foreign' }],
      ['mcp__lucid_quine__lucid_dispatch', { ...valid, tool: 'lucid.set' }],
      ['mcp__lucid_quine__lucid_dispatch', { ...valid, extra: true }],
      ['mcp__lucid_quine__lucid_dispatch', { ...valid, error: 'different' }],
      [
        'mcp__lucid_quine__lucid_get',
        { error: 'raw private text', code: 'lucid-invalid-receipt', retryable: false }
      ]
    ]

    for (const [toolName, value] of cases) {
      expect(parseLucidSafetyState(toolName, value)).toBeNull()
    }
  })
})
