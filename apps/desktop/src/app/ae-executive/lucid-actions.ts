import type { AeExecutiveScene } from './scene'

export const LUCID_ACTION_VERBS = ['show', 'get', 'set', 'morph', 'dispatch', 'steer', 'cancel'] as const
export type LucidActionVerb = (typeof LUCID_ACTION_VERBS)[number]
export type LucidActionPosture = 'held' | 'read' | 'ready'

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const RECEIPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const TRUST = new Set(['untrusted', 'attested', 'signed', 'verified'])

const REFUSALS = new Set([
  'no-capability', 'scope-violation', 'bad-signature', 'unknown-verb',
  'malformed-args', 'escalation-denied', 'fidelity-floor', 'internal-error'
])

const READ_VERBS = new Set<LucidActionVerb>(['show', 'get'])

export interface LucidActionContext {
  generation: number
  documentHash: string
  posture: LucidActionPosture
}

export interface LucidActionIntent {
  schema: 'hermes-lucid-executive-intent/1'
  verb: LucidActionVerb
  payload: Record<string, unknown>
  expected_generation: number
  expected_document_hash: string
  operation_id: string
}

export interface LucidActionReceipt {
  schema: 'hermes-lucid-receipt/1'
  id: string
  timestamp: string
  verb: LucidActionVerb
  ran: boolean
  trust: 'untrusted' | 'attested' | 'signed' | 'verified'
  content_hash: string
  refusal_code: null | string
  needs_user: boolean
}

export type LucidActionResult =
  | { result: unknown; lucid_receipt: LucidActionReceipt }
  | { error: string; lucid_receipt: LucidActionReceipt }
  | { error: string; code: string; retryable: false; operation_id?: string }

const exactObject = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value as object).length === keys.length && keys.every(key => Object.hasOwn(value as object, key))

export function lucidActionContext(batch: unknown, scene: AeExecutiveScene): LucidActionContext {
  const row = batch && typeof batch === 'object' && !Array.isArray(batch) ? batch as Record<string, unknown> : {}
  const receipt = scene.receipt ?? {}
  const scenes = Array.isArray(row.scenes) ? row.scenes : []

  const lucidRow = scenes.find(candidate =>
    Boolean(candidate) && typeof candidate === 'object' &&
    (candidate as Record<string, unknown>).tab === 'lucid'
  ) as Record<string, unknown> | undefined

  const generation = Number(row.generation ?? receipt.generation ?? receipt.revision)
  const documentHash = String(row.document_hash ?? receipt.document_hash ?? '')
  const postureValue = row.lucid_posture ?? receipt.lucid_posture ?? receipt.posture

  const explicitPosture = ['held', 'read', 'ready'].includes(String(postureValue))
    ? postureValue as LucidActionPosture
    : null

  const admittedRead = Number.isSafeInteger(generation) && generation > 0 && HASH_RE.test(documentHash) &&
    lucidRow?.state === 'fresh'

  const posture = admittedRead ? explicitPosture ?? 'read' : 'held'

  return {
    generation: Number.isSafeInteger(generation) && generation > 0 ? generation : 0,
    documentHash: HASH_RE.test(documentHash) ? documentHash : '',
    posture
  }
}

export function lucidActionForHandler(action: string): Pick<LucidActionIntent, 'verb' | 'payload'> | null {
  const exact: Record<string, Pick<LucidActionIntent, 'verb' | 'payload'>> = {
    'lucid.show.projects': { verb: 'show', payload: { kind: 'projects' } },
    'lucid.show.status': { verb: 'show', payload: { kind: 'status' } },
    'lucid.get.evidence': { verb: 'get', payload: { kind: 'evidence' } },
    'lucid.get.posture': { verb: 'get', payload: { kind: 'posture' } },
    'lucid.set.view-policy': { verb: 'set', payload: { kind: 'view-policy', value: 'balanced' } },
    'lucid.set.view-policy.compact': { verb: 'set', payload: { kind: 'view-policy', value: 'compact' } },
    'lucid.morph.fidelity': { verb: 'morph', payload: { kind: 'fidelity', value: 'balanced' } },
    'lucid.morph.fidelity.lossless': { verb: 'morph', payload: { kind: 'fidelity', value: 'lossless' } },
    'lucid.steer.hold.em': { verb: 'steer', payload: { kind: 'role', action: 'hold', scope: 'role:em' } },
    'lucid.steer.hold.sidekick': { verb: 'steer', payload: { kind: 'role', action: 'hold', scope: 'role:sidekick' } }
  }

  if (exact[action]) {return exact[action]}
  const plan = action.match(/^lucid\.dispatch\.plan:([0-9a-f]{64})$/)

  if (plan) {return { verb: 'dispatch', payload: { kind: 'plan', id: `plan:${plan[1]}` } }}
  const cancel = action.match(/^lucid\.cancel\.execution:([0-9a-f]{64}):(graceful|immediate)$/)

  if (cancel) {
    return {
      verb: 'cancel',
      payload: { kind: 'execution', id: `dispatch:${cancel[1]}`, mode: cancel[2] }
    }
  }

  return null
}

export function buildLucidActionIntent(
  action: string,
  context: LucidActionContext,
  operationId = newOperationId()
): LucidActionIntent | null {
  const selected = lucidActionForHandler(action)

  if (!selected || context.generation < 1 || !HASH_RE.test(context.documentHash)) {return null}

  if (context.posture === 'held' || context.posture === 'read' && !READ_VERBS.has(selected.verb)) {return null}

  return {
    schema: 'hermes-lucid-executive-intent/1',
    ...selected,
    expected_generation: context.generation,
    expected_document_hash: context.documentHash,
    operation_id: operationId
  }
}

export function applyLucidActionPosture(scene: AeExecutiveScene, context: LucidActionContext): AeExecutiveScene {
  let changed = false

  const nodes = scene.nodes.map(node => {
    const handlers = Object.values(node.on ?? {})
    const lucidHandlers = handlers.filter(handler => handler.startsWith('lucid.'))

    if (!lucidHandlers.length) {return node}

    const enabled = lucidHandlers.every(handler => {
      const selected = lucidActionForHandler(handler)

      return Boolean(selected) && context.generation > 0 && HASH_RE.test(context.documentHash) &&
        context.posture !== 'held' && (context.posture === 'ready' || READ_VERBS.has(selected!.verb))
    })

    if (enabled) {return node}
    changed = true

    return {
      ...node,
      a: {
        ...(node.a ?? {}),
        disabled: true,
        disabled_reason: context.posture === 'read' ? 'owner-capability-required' : 'authority-held'
      },
      on: undefined
    }
  })

  return changed ? { ...scene, nodes } : scene
}

export function parseLucidActionReceipt(value: unknown, expectedVerb: LucidActionVerb): LucidActionReceipt | null {
  if (!exactObject(value, [
    'schema', 'id', 'timestamp', 'verb', 'ran', 'trust', 'content_hash', 'refusal_code', 'needs_user'
  ])) {return null}

  if (
    value.schema !== 'hermes-lucid-receipt/1' || value.verb !== expectedVerb ||
    typeof value.id !== 'string' || !RECEIPT_ID_RE.test(value.id) ||
    typeof value.timestamp !== 'string' || !TIMESTAMP_RE.test(value.timestamp) ||
    typeof value.ran !== 'boolean' || typeof value.trust !== 'string' || !TRUST.has(value.trust) ||
    typeof value.content_hash !== 'string' || !HASH_RE.test(value.content_hash) ||
    !(value.refusal_code === null || typeof value.refusal_code === 'string' && REFUSALS.has(value.refusal_code)) ||
    typeof value.needs_user !== 'boolean'
  ) {return null}

  return value as unknown as LucidActionReceipt
}

export function parseLucidActionResult(value: unknown, expectedVerb: LucidActionVerb): LucidActionResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return null}
  const row = value as Record<string, unknown>
  const hasReceipt = Object.hasOwn(row, 'lucid_receipt')

  if (hasReceipt) {
    const keys = Object.hasOwn(row, 'result') ? ['result', 'lucid_receipt'] : ['error', 'lucid_receipt']

    if (!exactObject(row, keys)) {return null}
    const receipt = parseLucidActionReceipt(row.lucid_receipt, expectedVerb)

    if (!receipt || Object.hasOwn(row, 'error') && typeof row.error !== 'string') {return null}

    return Object.hasOwn(row, 'result')
      ? { result: row.result, lucid_receipt: receipt }
      : { error: row.error as string, lucid_receipt: receipt }
  }

  if (!['error', 'code', 'retryable'].every(key => Object.hasOwn(row, key))) {return null}

  if (Object.keys(row).some(key => !['error', 'code', 'retryable', 'operation_id', 'server', 'tool'].includes(key))) {return null}

  if (typeof row.error !== 'string' || typeof row.code !== 'string' || row.retryable !== false) {return null}

  return {
    error: row.error,
    code: row.code,
    retryable: false,
    ...(typeof row.operation_id === 'string' ? { operation_id: row.operation_id } : {})
  }
}

export function createLucidActionCoordinator(
  execute: (request: LucidActionIntent) => Promise<unknown>,
  currentContext: () => LucidActionContext
) {
  let sequence = 0

  return {
    invalidate: () => {sequence += 1},
    run: async (action: string): Promise<LucidActionResult> => {
      const context = currentContext()
      const request = buildLucidActionIntent(action, context)

      if (!request) {return { error: 'LUCID action is unavailable in the current posture', code: 'lucid-authority-held', retryable: false }}
      const ownSequence = ++sequence
      const raw = await execute(request)
      const latest = currentContext()

      if (
        ownSequence !== sequence || latest.generation !== context.generation ||
        latest.documentHash !== context.documentHash
      ) {
        return {
          error: 'LUCID completion belongs to an older executive generation',
          code: 'lucid-stale-completion',
          retryable: false,
          operation_id: request.operation_id
        }
      }

      return parseLucidActionResult(raw, request.verb) ?? {
        error: 'Butler returned an invalid LUCID receipt',
        code: 'lucid-invalid-receipt',
        retryable: false,
        operation_id: request.operation_id
      }
    }
  }
}

function newOperationId(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)

  return `op:${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
