import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'

export const LUCID_EXECUTIVE_CHANNEL = 'hermes:ae-executive:lucid'
export const LUCID_EXECUTIVE_MAX_REQUEST_BYTES = 64 * 1024
export const LUCID_EXECUTIVE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const LUCID_EXECUTIVE_TIMEOUT_MS = 30_000

export const LUCID_VERBS = ['show', 'get', 'set', 'morph', 'dispatch', 'steer', 'cancel'] as const
export type LucidVerb = (typeof LUCID_VERBS)[number]
export type LucidExecutivePosture = 'held' | 'read' | 'ready'

const VERBS = new Set<string>(LUCID_VERBS)
const READ_VERBS = new Set<LucidVerb>(['show', 'get'])
const HASH_RE = /^sha256:[0-9a-f]{64}$/
const OPERATION_RE = /^op:[0-9a-f]{64}$/
const RECEIPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const DISPATCH_RE = /^dispatch:[0-9a-f]{64}$/
const PLAN_RE = /^plan:[0-9a-f]{64}$/
const TRUST = new Set(['untrusted', 'attested', 'signed', 'verified'])

const REFUSALS = new Set([
  'no-capability', 'scope-violation', 'bad-signature', 'unknown-verb',
  'malformed-args', 'escalation-denied', 'fidelity-floor', 'internal-error'
])

export interface LucidExecutiveIntent {
  schema: 'hermes-lucid-executive-intent/1'
  verb: LucidVerb
  payload: Record<string, unknown>
  expected_generation: number
  expected_document_hash: string
  operation_id: string
}

export interface LucidExecutiveState {
  generation: number
  documentHash: string
  posture: LucidExecutivePosture
  sessionId: string | null
}

export function lucidExecutiveStateFromBatch(value: unknown, sessionId: string | null): LucidExecutiveState {
  const batch = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const scenes = Array.isArray(batch.scenes) ? batch.scenes : []

  const lucidRow = scenes.find(row =>
    Boolean(row) && typeof row === 'object' && (row as Record<string, unknown>).tab === 'lucid'
  ) as Record<string, unknown> | undefined

  const scene = lucidRow?.scene && typeof lucidRow.scene === 'object' && !Array.isArray(lucidRow.scene)
    ? lucidRow.scene as Record<string, unknown>
    : {}

  const receipt = scene.receipt && typeof scene.receipt === 'object' && !Array.isArray(scene.receipt)
    ? scene.receipt as Record<string, unknown>
    : {}

  const generation = Number(batch.generation ?? receipt.generation ?? receipt.revision)
  const documentHash = String(batch.document_hash ?? receipt.document_hash ?? '')
  const candidatePosture = batch.lucid_posture ?? receipt.lucid_posture ?? receipt.posture

  const explicitPosture = ['held', 'read', 'ready'].includes(String(candidatePosture))
    ? candidatePosture as LucidExecutivePosture
    : null
  const admittedRead = Number.isSafeInteger(generation) && generation > 0 && HASH_RE.test(documentHash) &&
    Boolean(lucidRow?.scene)
  const posture = explicitPosture ?? (admittedRead ? 'read' : 'held')

  return {
    generation: Number.isSafeInteger(generation) && generation > 0 ? generation : 0,
    documentHash: HASH_RE.test(documentHash) ? documentHash : '',
    posture,
    sessionId
  }
}

export interface LucidReceipt {
  schema: 'hermes-lucid-receipt/1'
  id: string
  timestamp: string
  verb: LucidVerb
  ran: boolean
  trust: 'untrusted' | 'attested' | 'signed' | 'verified'
  content_hash: string
  refusal_code: null | string
  needs_user: boolean
}

export type LucidExecutiveResult =
  | { result: unknown; lucid_receipt: LucidReceipt }
  | { error: string; lucid_receipt: LucidReceipt }
  | {
      error: string
      code:
        | 'lucid-authority-held'
        | 'lucid-generation-conflict'
        | 'lucid-identity-unavailable'
        | 'lucid-invalid-receipt'
        | 'lucid-invalid-request'
        | 'lucid-no-capability'
        | 'lucid-outcome-unknown'
        | 'lucid-stale-completion'
        | 'lucid-transport-unavailable'
      retryable: false
      operation_id?: string
      server?: 'lucid-quine'
      tool?: `lucid.${LucidVerb}`
    }

export interface LucidMcpCall {
  toolName: `lucid.${LucidVerb}`
  arguments: Record<string, unknown>
  meta: Record<string, unknown>
}

export interface LucidMcpResult {
  isError: boolean
  structuredContent: unknown
}

export interface LucidExecutiveDependencies {
  currentState: () => LucidExecutiveState | Promise<LucidExecutiveState>
  callBridge: (call: LucidMcpCall) => Promise<LucidMcpResult>
  confirmationFor?: (request: LucidExecutiveIntent) => boolean | Promise<boolean>
}

const exactObject = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value as object).length === keys.length && keys.every(key => Object.hasOwn(value as object, key))

function safeString(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max
}

function validPayload(verb: LucidVerb, payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {return false}
  const row = payload as Record<string, unknown>

  switch (verb) {
    case 'show':
      return exactObject(row, ['kind']) && ['projects', 'status'].includes(String(row.kind)) ||
        exactObject(row, ['kind', 'view']) && row.kind === 'attention' && ['pulse', 'health'].includes(String(row.view))

    case 'get':
      return exactObject(row, ['kind']) && ['evidence', 'posture', 'status'].includes(String(row.kind))

    case 'set':
      return exactObject(row, ['kind', 'value']) && row.kind === 'view-policy' &&
        ['compact', 'expanded', 'balanced'].includes(String(row.value))

    case 'morph':
      return exactObject(row, ['kind', 'value']) && row.kind === 'fidelity' &&
        ['lossless', 'balanced', 'compact'].includes(String(row.value))

    case 'dispatch':
      return exactObject(row, ['kind', 'id']) && row.kind === 'plan' && typeof row.id === 'string' && PLAN_RE.test(row.id)

    case 'steer':
      return exactObject(row, ['kind', 'action', 'scope']) && row.kind === 'role' && row.action === 'hold' &&
        ['role:em', 'role:sidekick'].includes(String(row.scope))

    case 'cancel':
      return exactObject(row, ['kind', 'id', 'mode']) && row.kind === 'execution' &&
        typeof row.id === 'string' && DISPATCH_RE.test(row.id) &&
        ['graceful', 'immediate'].includes(String(row.mode))
  }
}

export function parseLucidExecutiveIntent(value: unknown): LucidExecutiveIntent | null {
  if (!exactObject(value, [
    'schema', 'verb', 'payload', 'expected_generation', 'expected_document_hash', 'operation_id'
  ])) {return null}

  if (
    value.schema !== 'hermes-lucid-executive-intent/1' ||
    typeof value.verb !== 'string' || !VERBS.has(value.verb) ||
    !Number.isSafeInteger(value.expected_generation) || Number(value.expected_generation) < 1 ||
    typeof value.expected_document_hash !== 'string' || !HASH_RE.test(value.expected_document_hash) ||
    typeof value.operation_id !== 'string' || !OPERATION_RE.test(value.operation_id)
  ) {return null}

  const verb = value.verb as LucidVerb

  if (!validPayload(verb, value.payload)) {return null}

  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LUCID_EXECUTIVE_MAX_REQUEST_BYTES) {return null}
  } catch {
    return null
  }

  return value as unknown as LucidExecutiveIntent
}

export function translateLucidExecutivePayload(request: LucidExecutiveIntent): Record<string, unknown> {
  const payload = request.payload

  switch (request.verb) {
    case 'show':
      return payload.kind === 'attention' ? { view: payload.view } : { kind: payload.kind }

    case 'get':
      return { path: ({ evidence: 'evidence', posture: 'pulse', status: 'gates' } as const)[String(payload.kind)] }

    case 'set':
      return { path: 'view-policy', value: payload.value }

    case 'morph':
      return { id: 'executive', codebook: payload.value }

    case 'dispatch':
      return { task: 'plan.dispatch', id: payload.id }

    case 'steer':
      return { action: payload.action, scope: payload.scope }

    case 'cancel':
      return { id: payload.id, mode: payload.mode }
  }
}

function safety(
  code: Extract<LucidExecutiveResult, { code: string }>['code'],
  error: string,
  operationId?: string,
  verb?: LucidVerb
): LucidExecutiveResult {
  return {
    error,
    code,
    retryable: false,
    ...(operationId ? { operation_id: operationId } : {}),
    ...(code === 'lucid-outcome-unknown' && verb ? { server: 'lucid-quine' as const, tool: `lucid.${verb}` as const } : {})
  }
}

export function parseLucidReceipt(value: unknown, expectedVerb: LucidVerb): LucidReceipt | null {
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

  return value as unknown as LucidReceipt
}

export function projectLucidMcpResult(result: LucidMcpResult, expectedVerb: LucidVerb): LucidExecutiveResult {
  if (!result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) {
    return safety('lucid-invalid-receipt', 'Butler returned an invalid LUCID receipt')
  }

  const structured = result.structuredContent as Record<string, unknown>
  const envelope = structured.envelope

  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return safety('lucid-invalid-receipt', 'Butler returned an invalid LUCID receipt')
  }

  const receipt = projectEnvelopeReceipt(envelope as Record<string, unknown>, expectedVerb)

  if (!receipt) {return safety('lucid-invalid-receipt', 'Butler returned an invalid LUCID receipt')}

  if (result.isError || receipt.refusal_code !== null) {
    return {
      error: receipt.refusal_code ? `Butler refused LUCID call (${receipt.refusal_code})` : 'Butler returned a LUCID error receipt',
      lucid_receipt: receipt
    }
  }

  if (!Object.hasOwn(structured, 'result')) {
    return safety('lucid-invalid-receipt', 'Butler returned an invalid LUCID success receipt')
  }

  return { result: structured.result, lucid_receipt: receipt }
}

function projectEnvelopeReceipt(envelope: Record<string, unknown>, expectedVerb: LucidVerb): LucidReceipt | null {
  if (!exactObject(envelope, ['intent', 'capability', 'escalation', 'fidelity', 'refusal', 'receipt'])) {return null}

  if (!exactObject(envelope.intent, ['verb', 'args']) || envelope.intent.verb !== expectedVerb) {return null}

  if (!exactObject(envelope.receipt, ['id', 'ts', 'trust', 'content_hash', 'ran', 'effect'])) {return null}
  const raw = envelope.receipt
  let refusalCode: null | string = null
  let needsUser = false

  if (envelope.refusal !== null) {
    if (!exactObject(envelope.refusal, ['code', 'reason']) || typeof envelope.refusal.code !== 'string') {return null}
    refusalCode = envelope.refusal.code
  }

  if (envelope.escalation !== null) {
    if (!exactObject(envelope.escalation, ['needs_user', 'reason']) || typeof envelope.escalation.needs_user !== 'boolean') {return null}
    needsUser = envelope.escalation.needs_user
  }

  return parseLucidReceipt({
    schema: 'hermes-lucid-receipt/1',
    id: raw.id,
    timestamp: raw.ts,
    verb: expectedVerb,
    ran: raw.ran,
    trust: raw.trust,
    content_hash: raw.content_hash,
    refusal_code: refusalCode,
    needs_user: needsUser
  }, expectedVerb)
}

export function createLucidExecutiveHandler(dependencies: LucidExecutiveDependencies) {
  return async (input: unknown): Promise<LucidExecutiveResult> => {
    const request = parseLucidExecutiveIntent(input)

    if (!request) {return safety('lucid-invalid-request', 'LUCID executive intent is malformed')}
    const before = await dependencies.currentState()

    if (before.generation !== request.expected_generation || before.documentHash !== request.expected_document_hash) {
      return safety('lucid-generation-conflict', 'Executive generation or document hash changed', request.operation_id)
    }

    if (before.posture === 'held') {
      return safety('lucid-authority-held', 'LUCID authority posture is held', request.operation_id)
    }

    if (!safeString(before.sessionId, 192) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(before.sessionId)) {
      return safety('lucid-identity-unavailable', 'Owner-issued role-session identity is unavailable', request.operation_id)
    }

    if (!READ_VERBS.has(request.verb) && before.posture !== 'ready') {
      return safety('lucid-no-capability', 'Owner-issued LUCID capability is unavailable', request.operation_id)
    }

    const arguments_ = translateLucidExecutivePayload(request)
    const hostContext: Record<string, unknown> = { session_id: before.sessionId }

    if (request.verb === 'cancel' && await dependencies.confirmationFor?.(request)) {
      hostContext.exact_confirmation = {
        schema: 'lucid-exact-confirmation/1',
        verb: 'cancel',
        arguments_hash: sha256Canonical(arguments_)
      }
    }

    let projected: LucidExecutiveResult

    try {
      const result = await dependencies.callBridge({
        toolName: `lucid.${request.verb}`,
        arguments: arguments_,
        meta: { 'com.nous.lucid/host-context': hostContext }
      })

      projected = projectLucidMcpResult(result, request.verb)
    } catch {
      return READ_VERBS.has(request.verb)
        ? safety('lucid-transport-unavailable', 'LUCID Butler bridge is unavailable', request.operation_id)
        : safety('lucid-outcome-unknown', 'LUCID call outcome is unknown; automatic retry is disabled', request.operation_id, request.verb)
    }

    const after = await dependencies.currentState()

    if (after.generation !== before.generation || after.documentHash !== before.documentHash) {
      return safety('lucid-stale-completion', 'LUCID completion belongs to an older executive generation', request.operation_id)
    }

    return projected
  }
}

export async function callInstalledButler(
  butlerPath: string,
  admittedButlerPath: string,
  call: LucidMcpCall,
  options: { timeoutMs?: number } = {}
): Promise<LucidMcpResult> {
  const resolved = fs.realpathSync(butlerPath)
  const admitted = fs.realpathSync(admittedButlerPath)

  if (resolved !== admitted || !fs.statSync(resolved).isFile()) {throw new Error('lucid-butler-provenance-refused')}
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? LUCID_EXECUTIVE_TIMEOUT_MS, 1), LUCID_EXECUTIVE_TIMEOUT_MS)

  return new Promise((resolve, reject) => {
    const child = spawn(resolved, ['--mcp-stdio'], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let settled = false
    let stdout = ''

    const finish = (error?: Error, value?: LucidMcpResult) => {
      if (settled) {return}
      settled = true
      clearTimeout(timer)
      child.kill()

      if (error) {reject(error)} else {resolve(value!)}
    }

    const timer = setTimeout(() => finish(new Error('lucid-butler-timeout')), timeoutMs)

    child.on('error', error => finish(error))
    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8')

      if (Buffer.byteLength(stdout, 'utf8') > LUCID_EXECUTIVE_MAX_RESPONSE_BYTES) {
        finish(new Error('lucid-butler-response-bound'))

        return
      }

      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) {continue}
        let frame: Record<string, unknown>

        try {frame = JSON.parse(line)} catch {finish(new Error('lucid-butler-invalid-frame'));

 return}

        if (frame.id !== 2) {continue}

        if (frame.error) {finish(new Error('lucid-butler-jsonrpc-error'));

 return}

        const result = frame.result as Record<string, unknown> | undefined
        finish(undefined, {
          isError: result?.isError === true,
          structuredContent: result?.structuredContent
        })
      }
    })

    const initialize = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hermes-desktop', version: '1' } }
    }

    const invoke = {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: call.toolName, arguments: call.arguments, _meta: call.meta }
    }

    child.stdin.end(`${JSON.stringify(initialize)}\n${JSON.stringify(invoke)}\n`)
  })
}

function sha256Canonical(value: unknown): string {
  const canonical = JSON.stringify(sortJson(value))

  return `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(sortJson)}

  if (!value || typeof value !== 'object') {return value}

  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(
    ([key, item]) => [key, sortJson(item)]
  ))
}
