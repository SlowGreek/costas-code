export type LucidVerb = 'cancel' | 'dispatch' | 'get' | 'morph' | 'set' | 'show' | 'steer'
export type LucidTrust = 'attested' | 'signed' | 'untrusted' | 'verified'
export type LucidRefusalCode =
  | 'bad-signature'
  | 'escalation-denied'
  | 'fidelity-floor'
  | 'internal-error'
  | 'malformed-args'
  | 'no-capability'
  | 'scope-violation'
  | 'unknown-verb'

export interface LucidReceipt {
  schema: 'hermes-lucid-receipt/1'
  id: string
  timestamp: string
  verb: LucidVerb
  ran: boolean
  trust: LucidTrust
  content_hash: string
  refusal_code: LucidRefusalCode | null
  needs_user: boolean
}

export interface ParsedLucidToolResult {
  error: null | string
  receipt: LucidReceipt
  result: unknown
}

const VERBS: readonly LucidVerb[] = ['show', 'get', 'set', 'morph', 'dispatch', 'steer', 'cancel']
const TRUST: readonly LucidTrust[] = ['untrusted', 'attested', 'signed', 'verified']

const REFUSALS: readonly LucidRefusalCode[] = [
  'no-capability',
  'scope-violation',
  'bad-signature',
  'unknown-verb',
  'malformed-args',
  'escalation-denied',
  'fidelity-floor',
  'internal-error'
]

const TOOL_NAMES = new Map<LucidVerb, string>(VERBS.map(verb => [verb, `mcp__lucid_quine__lucid_${verb}`]))
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HASH_RE = /^sha256:[0-9a-f]{64}$/
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

function record(value: unknown): null | Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function closed(value: unknown, keys: readonly string[]): null | Record<string, unknown> {
  const object = record(value)

  if (!object || Object.keys(object).sort().join('\0') !== [...keys].sort().join('\0')) {
    return null
  }

  return object
}

function parseResult(value: unknown): null | Record<string, unknown> {
  if (typeof value !== 'string') {
    return record(value)
  }

  try {
    return record(JSON.parse(value))
  } catch {
    return null
  }
}

function parseReceipt(value: unknown, expectedVerb: LucidVerb): LucidReceipt | null {
  const receipt = closed(value, [
    'schema',
    'id',
    'timestamp',
    'verb',
    'ran',
    'trust',
    'content_hash',
    'refusal_code',
    'needs_user'
  ])

  if (!receipt) {
    return null
  }

  const { schema, id, timestamp, verb, ran, trust, content_hash, refusal_code, needs_user } = receipt

  if (
    schema !== 'hermes-lucid-receipt/1' ||
    typeof id !== 'string' ||
    !ID_RE.test(id) ||
    typeof timestamp !== 'string' ||
    !TIMESTAMP_RE.test(timestamp) ||
    verb !== expectedVerb ||
    !VERBS.includes(verb as LucidVerb) ||
    typeof ran !== 'boolean' ||
    !TRUST.includes(trust as LucidTrust) ||
    typeof content_hash !== 'string' ||
    !HASH_RE.test(content_hash) ||
    (refusal_code !== null && !REFUSALS.includes(refusal_code as LucidRefusalCode)) ||
    typeof needs_user !== 'boolean'
  ) {
    return null
  }

  return receipt as unknown as LucidReceipt
}

export function parseLucidToolResult(toolName: string, value: unknown): ParsedLucidToolResult | null {
  const expectedVerb = VERBS.find(verb => TOOL_NAMES.get(verb) === toolName)

  if (!expectedVerb) {
    return null
  }

  const object = parseResult(value)

  if (!object) {
    return null
  }

  const hasResult = Object.hasOwn(object, 'result')
  const hasError = Object.hasOwn(object, 'error')
  const expectedKeys = hasResult && !hasError ? ['result', 'lucid_receipt'] : !hasResult && hasError ? ['error', 'lucid_receipt'] : []

  if (expectedKeys.length === 0 || !closed(object, expectedKeys)) {
    return null
  }

  const receipt = parseReceipt(object.lucid_receipt, expectedVerb)

  if (!receipt || (hasError && (typeof object.error !== 'string' || object.error.length > 512))) {
    return null
  }

  return {
    error: hasError ? (object.error as string) : null,
    receipt,
    result: hasResult ? object.result : null
  }
}
