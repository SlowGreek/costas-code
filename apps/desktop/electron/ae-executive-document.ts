import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { type UguiDocument, validateUguiDocument } from '@hermes/shared/ugui-document'

export const AE_EXECUTIVE_DOCUMENT_MAX_BYTES = 2 * 1024 * 1024
export const AE_EXECUTIVE_DOCUMENT_TIMEOUT_MS = 15_000
export const AE_EXECUTIVE_DOCUMENT_TABS = [
  'home',
  'dashboard',
  'lucid',
  'quine',
  'scores',
  'metrics',
  'logs',
  'github',
  'studio',
  'settings',
  'marketplace',
  'shell',
  'mermaid'
] as const

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const ARTIFACT_GENERATION_RE = /^sha256:[0-9a-f]{64}$/
const FRESHNESS = new Set(['fresh', 'degraded', 'stale', 'unavailable'])
const POSTURES = new Set(['observed', 'missing', 'fixture', 'held', 'structural', 'unavailable'])
const ENVELOPE_FIELDS = [
  'schema',
  'authority',
  'executive_generation',
  'document_hash',
  'source_set_hash',
  'observed_ms',
  'freshness',
  'artifact_posture',
  'admission_code',
  'blocker',
  'rows'
]
const ROW_FIELDS = [
  'schema',
  'tab',
  'source_hash',
  'source_generation',
  'observed_ms',
  'freshness',
  'posture',
  'artifact_posture',
  'document',
  'code'
]

export type AeExecutiveAuthority = 'none' | 'RUN_EXECUTIVE_COMPOSER'
export type AeExecutiveFreshness = 'fresh' | 'degraded' | 'stale' | 'unavailable'
export type AeExecutivePosture = 'observed' | 'missing' | 'fixture' | 'held' | 'structural' | 'unavailable'

export interface AeExecutiveBlocker {
  code: string
  boundary: string
  closed: true
}

export interface AeExecutiveDocumentRow {
  schema: 'ae-executive-document-row/1'
  tab: string
  source_hash: string | null
  source_generation: number
  observed_ms: number | null
  freshness: AeExecutiveFreshness
  posture: AeExecutivePosture
  artifact_posture: AeExecutivePosture
  document: UguiDocument | null
  code: string | null
}

export interface AeExecutiveDocumentEnvelope {
  schema: 'ae-executive-document-envelope/1'
  authority: AeExecutiveAuthority
  executive_generation: number
  document_hash: string | null
  source_set_hash: string | null
  observed_ms: number | null
  freshness: AeExecutiveFreshness
  artifact_posture: AeExecutivePosture
  admission_code: string
  blocker: AeExecutiveBlocker | null
  rows: AeExecutiveDocumentRow[]
}

export type AeExecutiveBoundDocumentEnvelope = AeExecutiveDocumentEnvelope & {
  artifact_generation: string
}

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))

const safeText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value)

function validateBlocker(value: unknown): AeExecutiveBlocker | null {
  if (value === null) {return null}

  if (
    !object(value) ||
    !exact(value, ['code', 'boundary', 'closed']) ||
    !safeText(value.code) ||
    !safeText(value.boundary) ||
    value.closed !== true
  ) {
    throw new Error('ae-executive-document-blocker')
  }

  return { code: value.code, boundary: value.boundary, closed: true }
}

function validateRow(value: unknown, expectedTab: string): AeExecutiveDocumentRow {
  if (!object(value) || !exact(value, ROW_FIELDS)) {throw new Error(`ae-executive-document-row:${expectedTab}`)}

  if (
    value.schema !== 'ae-executive-document-row/1' ||
    value.tab !== expectedTab ||
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

  return { ...value, document } as unknown as AeExecutiveDocumentRow
}

export function validateAeExecutiveDocumentEnvelope(value: unknown): AeExecutiveDocumentEnvelope {
  if (!object(value) || !exact(value, ENVELOPE_FIELDS)) {
    throw new Error('ae-executive-document-envelope')
  }

  if (
    value.schema !== 'ae-executive-document-envelope/1' ||
    !['none', 'RUN_EXECUTIVE_COMPOSER'].includes(String(value.authority)) ||
    !Number.isSafeInteger(value.executive_generation) ||
    Number(value.executive_generation) < 0 ||
    typeof value.freshness !== 'string' ||
    !FRESHNESS.has(value.freshness) ||
    typeof value.artifact_posture !== 'string' ||
    !POSTURES.has(value.artifact_posture) ||
    !safeText(value.admission_code) ||
    !Array.isArray(value.rows) ||
    value.rows.length !== AE_EXECUTIVE_DOCUMENT_TABS.length
  ) {
    throw new Error('ae-executive-document-envelope')
  }

  const generation = Number(value.executive_generation)

  if (generation > 0) {
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

  const blocker = validateBlocker(value.blocker)

  if (
    generation === 0 && value.authority !== 'none' ||
    value.authority === 'RUN_EXECUTIVE_COMPOSER' && blocker !== null
  ) {
    throw new Error('ae-executive-document-authority')
  }

  const rows = value.rows.map((row, index) => validateRow(row, AE_EXECUTIVE_DOCUMENT_TABS[index]))

  return { ...value, blocker, rows } as unknown as AeExecutiveDocumentEnvelope
}

export function resolveAeExecutiveDocumentBinary(options: { generationRoot: string }): string | null {
  const executable = process.platform === 'win32' ? 'ae-executive-document.exe' : 'ae-executive-document'
  const candidate = path.join(options.generationRoot, executable)

  try {
    return fs.statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

function boundedExecutiveError(cause: unknown): string {
  return cause instanceof Error && /^ae-executive-[a-z0-9:-]{1,160}$/.test(cause.message)
    ? cause.message
    : 'admission-refused'
}

export function runAeExecutiveDocumentProjector(
  binary: string,
  artifactGeneration: string
): Promise<AeExecutiveBoundDocumentEnvelope> {
  if (!ARTIFACT_GENERATION_RE.test(artifactGeneration)) {
    return Promise.reject(new Error('ae-executive-artifact-generation'))
  }

  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [],
      { timeout: AE_EXECUTIVE_DOCUMENT_TIMEOUT_MS, maxBuffer: AE_EXECUTIVE_DOCUMENT_MAX_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) {return reject(new Error('ae-executive-projector-failed'))}

        try {
          const envelope = validateAeExecutiveDocumentEnvelope(JSON.parse(String(stdout)))
          resolve({ ...envelope, artifact_generation: artifactGeneration })
        } catch (cause) {
          reject(new Error(`ae-executive-projector-invalid:${boundedExecutiveError(cause)}`))
        }
      }
    )
  })
}
