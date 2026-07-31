import { type UguiDocument, validateUguiDocument } from '@hermes/shared/ugui-document'

import { AE_EXECUTIVE_TAB_IDS } from './contract'

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const FRESHNESS = new Set(['fresh', 'degraded', 'stale', 'unavailable'])
const POSTURES = new Set(['observed', 'missing', 'fixture', 'held', 'structural', 'unavailable'])

export type AeExecutiveAuthority = 'none' | 'RUN_EXECUTIVE_COMPOSER'
export type AeExecutiveFreshness = 'fresh' | 'degraded' | 'stale' | 'unavailable'
export type AeExecutivePosture = 'live' | 'degraded' | 'stale' | 'unavailable'
export type AeExecutiveDocumentState = 'fresh' | 'stale' | 'unavailable' | 'fixture' | 'structural'

export interface AeExecutiveBlocker {
  readonly code: string
  readonly boundary: string
  readonly closed: true
}

export interface AeExecutiveDocumentRow {
  readonly schema: 'ae-executive-document-row/1'
  readonly tab: string
  readonly source_hash: string | null
  readonly source_generation: number
  readonly observed_ms: number | null
  readonly freshness: AeExecutiveFreshness
  readonly posture: 'observed' | 'missing' | 'fixture' | 'held' | 'structural' | 'unavailable'
  readonly artifact_posture: 'observed' | 'missing' | 'fixture' | 'held' | 'structural' | 'unavailable'
  readonly document: UguiDocument | null
  readonly code: string | null
  readonly state: AeExecutiveDocumentState
  readonly preserved?: boolean
}

export interface AeExecutiveDocumentBatch {
  readonly schema: 'ae-executive-document-envelope/1'
  readonly authority: AeExecutiveAuthority
  readonly generation: number | null
  readonly document_hash: string | null
  readonly source_set_hash: string | null
  readonly observed_ms: number | null
  readonly freshness: AeExecutiveFreshness
  readonly artifact_generation: string
  readonly posture: AeExecutivePosture
  readonly artifact_posture: string
  readonly admission_code: string
  readonly blocker: AeExecutiveBlocker | null
  readonly rows: readonly AeExecutiveDocumentRow[]
}

export type ExecutiveReconcileResult =
  | { readonly accepted: true; readonly batch: AeExecutiveDocumentBatch; readonly reason: 'accepted' | 'duplicate' }
  | { readonly accepted: false; readonly batch: AeExecutiveDocumentBatch; readonly reason: string }

export interface StudioDesignerContext {
  readonly revision: number
  readonly documentHash: string
}

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const safeText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value)

function parseBlocker(value: unknown): AeExecutiveBlocker | null {
  if (value === null) {return null}

  if (!object(value) || !safeText(value.code) || !safeText(value.boundary) || value.closed !== true) {
    throw new Error('ae-executive-document-blocker')
  }

  return { code: value.code, boundary: value.boundary, closed: true }
}

function documentState(row: Record<string, unknown>, document: UguiDocument | null): AeExecutiveDocumentState {
  if (!document || ['missing', 'held', 'unavailable'].includes(String(row.posture))) {return 'unavailable'}
  if (row.posture === 'fixture') {return 'fixture'}
  if (row.posture === 'structural') {return 'structural'}
  if (row.freshness === 'stale') {return 'stale'}

  return 'fresh'
}

function parseRow(value: unknown, expectedTab: string): AeExecutiveDocumentRow {
  if (!object(value) || value.schema !== 'ae-executive-document-row/1' || value.tab !== expectedTab) {
    throw new Error(`ae-executive-document-row:${expectedTab}`)
  }

  if (
    !Number.isSafeInteger(value.source_generation) ||
    Number(value.source_generation) < 0 ||
    !(value.source_hash === null || typeof value.source_hash === 'string' && HASH_RE.test(value.source_hash)) ||
    !(value.observed_ms === null || Number.isSafeInteger(value.observed_ms) && Number(value.observed_ms) >= 0) ||
    typeof value.freshness !== 'string' ||
    !FRESHNESS.has(value.freshness) ||
    typeof value.posture !== 'string' ||
    !POSTURES.has(value.posture) ||
    typeof value.artifact_posture !== 'string' ||
    !POSTURES.has(value.artifact_posture) ||
    !(value.code === null || safeText(value.code))
  ) {
    throw new Error(`ae-executive-document-row:${expectedTab}`)
  }

  const document = value.document === null ? null : validateUguiDocument(value.document)

  return {
    ...value,
    document,
    state: documentState(value, document)
  } as unknown as AeExecutiveDocumentRow
}

export function parseExecutiveDocumentEnvelope(value: unknown): AeExecutiveDocumentBatch {
  if (!object(value) || value.schema !== 'ae-executive-document-envelope/1') {
    throw new Error('ae-executive-document-envelope')
  }

  if (
    !['none', 'RUN_EXECUTIVE_COMPOSER'].includes(String(value.authority)) ||
    !Number.isSafeInteger(value.executive_generation) ||
    Number(value.executive_generation) < 0 ||
    typeof value.freshness !== 'string' ||
    !FRESHNESS.has(value.freshness) ||
    typeof value.artifact_posture !== 'string' ||
    !POSTURES.has(value.artifact_posture) ||
    !safeText(value.admission_code) ||
    typeof value.artifact_generation !== 'string' ||
    !HASH_RE.test(value.artifact_generation) ||
    !Array.isArray(value.rows) ||
    value.rows.length !== AE_EXECUTIVE_TAB_IDS.length
  ) {
    throw new Error('ae-executive-document-envelope')
  }

  const executiveGeneration = Number(value.executive_generation)
  const live = executiveGeneration > 0

  if (live) {
    if (
      typeof value.document_hash !== 'string' ||
      !HASH_RE.test(value.document_hash) ||
      typeof value.source_set_hash !== 'string' ||
      !HASH_RE.test(value.source_set_hash) ||
      !Number.isSafeInteger(value.observed_ms) ||
      Number(value.observed_ms) < 0
    ) {
      throw new Error('ae-executive-document-provenance')
    }
  } else if (value.document_hash !== null || value.source_set_hash !== null || value.observed_ms !== null) {
    throw new Error('ae-executive-document-provenance')
  }

  const blocker = parseBlocker(value.blocker)

  if (
    executiveGeneration === 0 && value.authority !== 'none' ||
    value.authority === 'RUN_EXECUTIVE_COMPOSER' && blocker !== null
  ) {
    throw new Error('ae-executive-document-authority')
  }

  const rows = value.rows.map((row, index) => parseRow(row, AE_EXECUTIVE_TAB_IDS[index]))
  const freshness = value.freshness as AeExecutiveFreshness
  const posture: AeExecutivePosture = !live || freshness === 'unavailable'
    ? 'unavailable'
    : blocker || freshness === 'degraded'
      ? 'degraded'
      : freshness === 'stale'
        ? 'stale'
        : 'live'

  return {
    schema: 'ae-executive-document-envelope/1',
    authority: value.authority as AeExecutiveAuthority,
    generation: live ? executiveGeneration : null,
    document_hash: live ? value.document_hash as string : null,
    source_set_hash: live ? value.source_set_hash as string : null,
    observed_ms: live ? Number(value.observed_ms) : null,
    freshness,
    artifact_generation: value.artifact_generation,
    posture,
    artifact_posture: value.artifact_posture,
    admission_code: value.admission_code,
    blocker,
    rows
  }
}

export function documentForTab(batch: AeExecutiveDocumentBatch, tab: string): UguiDocument {
  const found = batch.rows.find(row => row.tab === tab)

  if (!found?.document) {throw new Error(found?.code ?? `ae-executive-document-missing:${tab}`)}

  return found.document
}

export function studioDesignerContext(row: AeExecutiveDocumentRow): StudioDesignerContext | null {
  if (!row.document || row.source_generation < 0 || !row.source_hash || !HASH_RE.test(row.source_hash)) {
    return null
  }

  return { revision: row.source_generation, documentHash: row.source_hash }
}

export function loadExecutiveDocuments(): Promise<AeExecutiveDocumentBatch> {
  return window.hermesDesktop.getAeExecutiveDocuments().then(parseExecutiveDocumentEnvelope)
}

export function resetExecutiveDocumentsForTests() {
  // There is deliberately no module-global settled Promise or renderer cache.
}

export function reconcileExecutiveDocuments(
  previous: AeExecutiveDocumentBatch | null,
  incoming: AeExecutiveDocumentBatch
): ExecutiveReconcileResult {
  if (!previous) {return { accepted: true, batch: incoming, reason: 'accepted' }}

  if (incoming.generation === null) {
    return { accepted: false, batch: previous, reason: 'unavailable-episode-not-live' }
  }

  if (previous.generation === null) {return { accepted: true, batch: incoming, reason: 'accepted' }}

  if (incoming.artifact_generation !== previous.artifact_generation) {
    return { accepted: false, batch: previous, reason: 'artifact-generation-conflict' }
  }

  if (incoming.generation < previous.generation) {
    return { accepted: false, batch: previous, reason: 'out-of-order-generation' }
  }

  if (incoming.observed_ms! < previous.observed_ms!) {
    return { accepted: false, batch: previous, reason: 'stale-observation' }
  }

  if (incoming.generation === previous.generation) {
    if (previous.authority === 'RUN_EXECUTIVE_COMPOSER' && incoming.authority === 'none') {
      return { accepted: false, batch: previous, reason: 'authority-regression' }
    }

    if (
      incoming.document_hash !== previous.document_hash ||
      incoming.source_set_hash !== previous.source_set_hash ||
      incoming.observed_ms !== previous.observed_ms ||
      incoming.freshness !== previous.freshness
    ) {
      return { accepted: false, batch: previous, reason: 'same-generation-conflict' }
    }

    if (previous.authority === 'none' && incoming.authority === 'RUN_EXECUTIVE_COMPOSER') {
      return { accepted: true, batch: incoming, reason: 'accepted' }
    }

    return { accepted: true, batch: previous, reason: 'duplicate' }
  }

  if (incoming.document_hash === previous.document_hash) {
    return { accepted: false, batch: previous, reason: 'generation-hash-conflict' }
  }

  const previousRows = new Map(previous.rows.map(row => [row.tab, row]))
  const rows = incoming.rows.map(row => {
    if (row.document && !['stale', 'unavailable'].includes(row.state)) {return row}
    const prior = previousRows.get(row.tab)

    return prior?.document ? { ...row, document: prior.document, preserved: true } : row
  })

  return { accepted: true, reason: 'accepted', batch: { ...incoming, rows } }
}
