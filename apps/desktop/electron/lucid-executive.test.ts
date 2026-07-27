import { describe, expect, it, vi } from 'vitest'

import {
  createLucidExecutiveHandler,
  parseLucidExecutiveIntent,
  parseLucidReceipt,
  type LucidExecutiveIntent,
  type LucidExecutiveState,
  type LucidVerb
} from './lucid-executive'

const HASH = `sha256:${'a'.repeat(64)}`
const OPERATION = `op:${'b'.repeat(64)}`
const DISPATCH = `dispatch:${'c'.repeat(64)}`
const PLAN = `plan:${'d'.repeat(64)}`

const payloads: Record<LucidVerb, Record<string, unknown>> = {
  show: { kind: 'projects' },
  get: { kind: 'evidence' },
  set: { kind: 'view-policy', value: 'compact' },
  morph: { kind: 'fidelity', value: 'lossless' },
  dispatch: { kind: 'plan', id: PLAN },
  steer: { kind: 'role', action: 'hold', scope: 'role:em' },
  cancel: { kind: 'execution', id: DISPATCH, mode: 'graceful' }
}

function request(verb: LucidVerb): LucidExecutiveIntent {
  return {
    schema: 'hermes-lucid-executive-intent/1',
    verb,
    payload: payloads[verb],
    expected_generation: 7,
    expected_document_hash: HASH,
    operation_id: OPERATION
  }
}

function state(posture: LucidExecutiveState['posture'] = 'ready'): LucidExecutiveState {
  return { generation: 7, documentHash: HASH, posture, sessionId: 'desktop:window-1' }
}

function bridgeResult(verb: LucidVerb, options: { refusal?: string; ran?: boolean } = {}) {
  return {
    isError: Boolean(options.refusal),
    structuredContent: {
      envelope: {
        intent: { verb, args: { private: 'not projected' } },
        capability: null,
        escalation: null,
        fidelity: { level: 'lossless', preserved: [], lost: [] },
        refusal: options.refusal ? { code: options.refusal, reason: 'private' } : null,
        receipt: {
          id: `lucid:${verb}`,
          ts: '2026-07-27T01:02:03Z',
          trust: options.refusal ? 'untrusted' : 'verified',
          content_hash: HASH,
          ran: options.ran ?? !options.refusal,
          effect: 'private'
        }
      },
      result: { ok: true }
    }
  }
}

describe('LUCID executive closed intent ingress', () => {
  it.each(Object.keys(payloads) as LucidVerb[])('admits and calls only the canonical %s tool', async verb => {
    const callBridge = vi.fn().mockResolvedValue(bridgeResult(verb))
    const handler = createLucidExecutiveHandler({ currentState: () => state(), callBridge })

    const result = await handler(request(verb))

    expect(callBridge).toHaveBeenCalledTimes(1)
    expect(callBridge.mock.calls[0][0].toolName).toBe(`lucid.${verb}`)
    expect(callBridge.mock.calls[0][0].arguments).not.toHaveProperty('capability')
    expect(callBridge.mock.calls[0][0].arguments).not.toHaveProperty('session_id')
    expect(result).toHaveProperty('lucid_receipt.verb', verb)
  })

  it('rejects open, malformed, and renderer authority fields before Butler', async () => {
    const callBridge = vi.fn()
    const handler = createLucidExecutiveHandler({ currentState: () => state(), callBridge })

    expect(parseLucidExecutiveIntent({ ...request('get'), executable: '/tmp/butler' })).toBeNull()
    expect(parseLucidExecutiveIntent({ ...request('get'), payload: { kind: 'evidence', path: '/tmp' } })).toBeNull()
    expect(parseLucidExecutiveIntent({ ...request('cancel'), payload: { ...payloads.cancel, capability: 'forged' } })).toBeNull()
    expect(await handler({ ...request('get'), verb: 'run' })).toMatchObject({ code: 'lucid-invalid-request' })
    expect(callBridge).not.toHaveBeenCalled()
  })

  it('admits show/get under read posture and refuses consequential calls without capability posture', async () => {
    const callBridge = vi.fn().mockImplementation(call => Promise.resolve(bridgeResult(call.toolName.slice(6))))
    const handler = createLucidExecutiveHandler({ currentState: () => state('read'), callBridge })

    expect(await handler(request('get'))).toHaveProperty('lucid_receipt.verb', 'get')
    expect(await handler(request('show'))).toHaveProperty('lucid_receipt.verb', 'show')
    expect(await handler(request('set'))).toMatchObject({ code: 'lucid-no-capability', retryable: false })
    expect(callBridge).toHaveBeenCalledTimes(2)
  })

  it('fails closed when identity or authority posture is held', async () => {
    const callBridge = vi.fn()
    const noIdentity = createLucidExecutiveHandler({
      currentState: () => ({ ...state(), sessionId: null }),
      callBridge
    })
    const held = createLucidExecutiveHandler({ currentState: () => state('held'), callBridge })

    expect(await noIdentity(request('get'))).toMatchObject({ code: 'lucid-identity-unavailable' })
    expect(await held(request('get'))).toMatchObject({ code: 'lucid-authority-held' })
    expect(callBridge).not.toHaveBeenCalled()
  })

  it('binds owner confirmation to exact cancel arguments outside renderer payload', async () => {
    const callBridge = vi.fn().mockResolvedValue(bridgeResult('cancel'))
    const confirmationFor = vi.fn().mockResolvedValue(true)
    const handler = createLucidExecutiveHandler({ currentState: () => state(), callBridge, confirmationFor })

    await handler(request('cancel'))

    expect(confirmationFor).toHaveBeenCalledWith(request('cancel'))
    expect(callBridge.mock.calls[0][0].meta['com.nous.lucid/host-context'].exact_confirmation).toMatchObject({
      schema: 'lucid-exact-confirmation/1',
      verb: 'cancel',
      arguments_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
    })
  })

  it('never retries an unknown consequential outcome', async () => {
    const callBridge = vi.fn().mockRejectedValue(new Error('response lost'))
    const handler = createLucidExecutiveHandler({ currentState: () => state(), callBridge })

    expect(await handler(request('dispatch'))).toEqual({
      error: 'LUCID call outcome is unknown; automatic retry is disabled',
      code: 'lucid-outcome-unknown',
      retryable: false,
      operation_id: OPERATION,
      server: 'lucid-quine',
      tool: 'lucid.dispatch'
    })
    expect(callBridge).toHaveBeenCalledTimes(1)
  })

  it('refuses generation conflicts before execution', async () => {
    const callBridge = vi.fn()
    const handler = createLucidExecutiveHandler({
      currentState: () => ({ ...state(), generation: 8 }),
      callBridge
    })

    expect(await handler(request('get'))).toMatchObject({ code: 'lucid-generation-conflict' })
    expect(callBridge).not.toHaveBeenCalled()
  })

  it('rejects a completion that became stale while Butler was running', async () => {
    const callBridge = vi.fn().mockResolvedValue(bridgeResult('set'))
    const currentState = vi.fn()
      .mockResolvedValueOnce(state())
      .mockResolvedValueOnce({ ...state(), generation: 8, documentHash: `sha256:${'e'.repeat(64)}` })
    const handler = createLucidExecutiveHandler({ currentState, callBridge })

    expect(await handler(request('set'))).toMatchObject({ code: 'lucid-stale-completion', retryable: false })
    expect(callBridge).toHaveBeenCalledTimes(1)
  })
})

describe('closed receipt parser', () => {
  it('parses exact receipts and rejects mismatches or open shapes', () => {
    const result = bridgeResult('get').structuredContent.envelope.receipt
    const receipt = {
      schema: 'hermes-lucid-receipt/1', id: result.id, timestamp: result.ts,
      verb: 'get', ran: result.ran, trust: result.trust, content_hash: result.content_hash,
      refusal_code: null, needs_user: false
    }

    expect(parseLucidReceipt(receipt, 'get')).toEqual(receipt)
    expect(parseLucidReceipt({ ...receipt, verb: 'set' }, 'get')).toBeNull()
    expect(parseLucidReceipt({ ...receipt, extra: true }, 'get')).toBeNull()
    expect(parseLucidReceipt({ ...receipt, content_hash: 'sha256:short' }, 'get')).toBeNull()
  })
})
