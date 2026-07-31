import { describe, expect, it, vi } from 'vitest'

import {
  applyLucidActionPosture,
  buildLucidActionIntent,
  createLucidActionCoordinator,
  type LucidActionContext,
  lucidActionForHandler,
  type LucidActionReceipt,
  parseLucidActionResult
} from './lucid-actions'
import type { UguiDocument } from '@hermes/shared/ugui-document'

const HASH = `sha256:${'a'.repeat(64)}`
const OPERATION = `op:${'b'.repeat(64)}`
const context: LucidActionContext = { generation: 4, documentHash: HASH, posture: 'ready' }

const handlers = [
  ['lucid.show.projects', 'show'],
  ['lucid.get.evidence', 'get'],
  ['lucid.set.view-policy', 'set'],
  ['lucid.morph.fidelity', 'morph'],
  [`lucid.dispatch.plan:${'c'.repeat(64)}`, 'dispatch'],
  ['lucid.steer.hold.em', 'steer'],
  [`lucid.cancel.execution:${'d'.repeat(64)}:graceful`, 'cancel']
] as const

function receipt(verb: LucidActionReceipt['verb']): LucidActionReceipt {
  return {
    schema: 'hermes-lucid-receipt/1',
    id: `lucid:${verb}`,
    timestamp: '2026-07-27T01:02:03Z',
    verb,
    ran: true,
    trust: 'verified',
    content_hash: HASH,
    refusal_code: null,
    needs_user: false
  }
}

describe('closed LUCID Document action registry', () => {
  it.each(handlers)('maps %s to typed %s intent without authority material', (handler, verb) => {
    const intent = buildLucidActionIntent(handler, context, OPERATION)

    expect(intent).toMatchObject({
      schema: 'hermes-lucid-executive-intent/1',
      verb,
      expected_generation: 4,
      expected_document_hash: HASH,
      operation_id: OPERATION
    })
    expect(intent).not.toHaveProperty('capability')
    expect(intent).not.toHaveProperty('session')
    expect(intent).not.toHaveProperty('executable')
  })

  it('refuses arbitrary or path-shaped Document actions', () => {
    expect(lucidActionForHandler('lucid.run./tmp/payload')).toBeNull()
    expect(lucidActionForHandler('lucid.dispatch.plan:../../secret')).toBeNull()
    expect(lucidActionForHandler('shell.exec')).toBeNull()
    expect(buildLucidActionIntent('lucid.get.evidence', { ...context, generation: 0 }, OPERATION)).toBeNull()
  })

  it('disables semantic action items while authority is held', () => {
    const document: UguiDocument = {
      id: 'lucid.document',
      type: 'document',
      header: [],
      sections: [],
      actions: [
        { id: 'read', type: 'button', label: 'Read', action: 'lucid.get.evidence' },
        { id: 'write', type: 'button', label: 'Write', action: 'lucid.set.view-policy' }
      ]
    }

    const held = applyLucidActionPosture(document, { ...context, posture: 'held' })

    expect((held.actions[0] as Record<string, unknown>).disabled).toBe(true)
    expect((held.actions[1] as Record<string, unknown>).disabled).toBe(true)

    const read = applyLucidActionPosture(document, { ...context, posture: 'read' })
    expect((read.actions[0] as Record<string, unknown>).disabled).toBeUndefined()
    expect((read.actions[1] as Record<string, unknown>).disabled_reason).toBe('owner-capability-required')
  })
})

describe('LUCID action receipt and completion admission', () => {
  it('parses exact success/refusal receipts and rejects open receipts', () => {
    const success = { result: { ok: true }, lucid_receipt: receipt('get') }

    expect(parseLucidActionResult(success, 'get')).toEqual(success)
    expect(parseLucidActionResult({ ...success, extra: true }, 'get')).toBeNull()
    expect(parseLucidActionResult({ ...success, lucid_receipt: { ...receipt('set'), verb: 'set' } }, 'get')).toBeNull()
    expect(parseLucidActionResult({
      error: 'Butler refused LUCID call (no-capability)',
      lucid_receipt: { ...receipt('set'), ran: false, trust: 'untrusted', refusal_code: 'no-capability' }
    }, 'set')).not.toBeNull()
  })

  it('drops a stale completion instead of applying it to a newer generation', async () => {
    let latest = context
    let resolvePending!: (value: unknown) => void
    const pending = new Promise<unknown>(resolve => {resolvePending = resolve})
    const execute = vi.fn().mockReturnValue(pending)
    const coordinator = createLucidActionCoordinator(execute, () => latest)
    const result = coordinator.run('lucid.get.evidence')

    latest = { ...context, generation: 5, documentHash: `sha256:${'e'.repeat(64)}` }
    resolvePending({ result: {}, lucid_receipt: receipt('get') })

    await expect(result).resolves.toMatchObject({ code: 'lucid-stale-completion', retryable: false })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('marks invalid IPC receipt output as nonretryable protocol failure', async () => {
    const coordinator = createLucidActionCoordinator(vi.fn().mockResolvedValue({ result: 'raw' }), () => context)

    await expect(coordinator.run('lucid.get.evidence')).resolves.toMatchObject({
      code: 'lucid-invalid-receipt',
      retryable: false
    })
  })
})
