import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const AE_EXECUTIVE_MAX_BYTES = 2 * 1024 * 1024
export const AE_EXECUTIVE_TIMEOUT_MS = 15_000
export const AE_EXECUTIVE_TABS = ['home', 'dashboard', 'lucid', 'quine', 'scores', 'metrics', 'logs', 'studio', 'settings'] as const
export const AE_EXECUTIVE_MAX_TABS = 36
export const AE_EXECUTIVE_HOST_DERIVED_TABS = ['shell'] as const

const SCENE_PRIMITIVES = new Set([
  'button', 'canvas', 'column', 'divider', 'image', 'input', 'native',
  'progress', 'row', 'select', 'spacer', 'stack', 'text'
])

const CONTAINER_PRIMITIVES = new Set(['column', 'row', 'stack'])
const SCENE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const TAB_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/
const HASH_RE = /^sha256:[0-9a-f]{64}$/
const ARTIFACT_GENERATION_RE = /^sha256:[0-9a-f]{64}$/
const FRESHNESS = new Set(['fresh', 'degraded', 'stale', 'unavailable'])
const TAB_STATES = new Set(['fresh', 'stale', 'unavailable', 'fixture', 'structural'])
const POSTURES = new Set(['observed', 'missing', 'fixture', 'held', 'structural', 'unavailable'])

export type AeExecutiveFreshness = 'fresh' | 'degraded' | 'stale' | 'unavailable'
export type AeExecutiveTabState = 'fresh' | 'stale' | 'unavailable' | 'fixture' | 'structural'

export interface AeExecutiveLegacySceneBatch {
  schema: 'ae-executive-scene-batch/1'
  authority: 'none'
  projector: string
  scenes: Array<{ tab: string; scene: Record<string, unknown> }>
  artifact_generation?: string
}

export interface AeExecutiveSceneRow {
  tab: string
  state: AeExecutiveTabState
  scene?: Record<string, unknown>
  reason?: string
}

export interface AeExecutiveSceneBatch {
  schema: 'ae-executive-scene-batch/2'
  authority: 'none'
  projector: string
  generation: number
  document_hash: string
  source_set_hash: string
  observed_ms: number
  freshness: AeExecutiveFreshness
  scenes: AeExecutiveSceneRow[]
  artifact_generation?: string
}

export interface AeExecutiveSceneEnvelope {
  schema: 'ae-executive-scene-envelope/1'
  authority: 'none' | 'RUN_EXECUTIVE_COMPOSER'
  executive_generation: number
  document_hash: string | null
  source_set_hash: string | null
  observed_ms: number | null
  freshness: AeExecutiveFreshness
  artifact_posture: string
  admission_code: string
  blocker: { code: string; boundary: string; closed: true } | null
  scenes: AeExecutiveSceneRow[]
  artifact_generation?: string
}

export type AeExecutiveProjectorBatch = AeExecutiveLegacySceneBatch | AeExecutiveSceneBatch | AeExecutiveSceneEnvelope
export type AeExecutiveBoundBatch = AeExecutiveProjectorBatch & { artifact_generation: string }

export function resolveAeExecutiveBinary(options: { generationRoot: string }): string | null {
  const executable = process.platform === 'win32' ? 'ae-executive-scene.exe' : 'ae-executive-scene'

  const candidates = [path.join(options.generationRoot, executable)]

  return candidates.find(candidate => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  }) ?? null
}

export function validateAeExecutiveBatch(value: unknown): AeExecutiveProjectorBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('ae-executive-batch-invalid')}
  const schema = (value as { schema?: unknown }).schema

  if (schema === 'ae-executive-scene-batch/1') {return validateLegacyBatch(value)}

  if (schema === 'ae-executive-scene-batch/2') {return validateGenerationBatch(value)}

  if (schema === 'ae-executive-scene-envelope/1') {return validateSceneEnvelope(value)}
  throw new Error('ae-executive-batch-schema')
}

function validateLegacyBatch(value: unknown): AeExecutiveLegacySceneBatch {
  const batch = value as Partial<AeExecutiveLegacySceneBatch>

  if (batch.schema !== 'ae-executive-scene-batch/1' || batch.authority !== 'none') {
    throw new Error('ae-executive-batch-schema')
  }

  const observed = validateBatchHeader(batch.projector, batch.scenes)
  const legacy = !observed.includes('marketplace')

  if (legacy && observed.length !== AE_EXECUTIVE_TABS.length) {
    throw new Error('ae-executive-batch-cardinality')
  }

  if (legacy && AE_EXECUTIVE_TABS.some((tab, index) => observed[index] !== tab)) {
    throw new Error('ae-executive-batch-order')
  }

  let canonicalHandlers: string[] | null = null
  let canonicalHotkeys: string[] | null = null

  for (const row of batch.scenes!) {
    if (!row.scene || typeof row.scene !== 'object' || Array.isArray(row.scene)) {
      throw new Error('ae-executive-scene-invalid')
    }

    const { handlers, hotkeys } = validateExecutiveScene(row.scene, row.tab, observed)

    if (
      canonicalHandlers &&
      (handlers.length !== canonicalHandlers.length || handlers.some((handler, index) => handler !== canonicalHandlers[index]))
    ) {
      throw new Error(`ae-executive-shell-action-drift:${row.tab}`)
    }

    if (
      canonicalHotkeys &&
      (hotkeys.length !== canonicalHotkeys.length || hotkeys.some((hotkey, index) => hotkey !== canonicalHotkeys[index]))
    ) {
      throw new Error(`ae-executive-hotkey-drift:${row.tab}`)
    }

    canonicalHandlers ??= handlers
    canonicalHotkeys ??= hotkeys
  }

  return {
    schema: 'ae-executive-scene-batch/1',
    authority: 'none',
    projector: batch.projector!,
    scenes: batch.scenes!
  }
}

function validateGenerationBatch(value: unknown): AeExecutiveSceneBatch {
  const batch = value as Partial<AeExecutiveSceneBatch>

  if (batch.schema !== 'ae-executive-scene-batch/2' || batch.authority !== 'none') {
    throw new Error('ae-executive-batch-schema')
  }

  if (!Number.isSafeInteger(batch.generation) || Number(batch.generation) < 1) {
    throw new Error('ae-executive-batch-generation')
  }

  if (typeof batch.document_hash !== 'string' || !HASH_RE.test(batch.document_hash)) {
    throw new Error('ae-executive-batch-document-hash')
  }

  if (typeof batch.source_set_hash !== 'string' || !HASH_RE.test(batch.source_set_hash)) {
    throw new Error('ae-executive-batch-source-set-hash')
  }

  if (!Number.isSafeInteger(batch.observed_ms) || Number(batch.observed_ms) < 0) {
    throw new Error('ae-executive-batch-observed')
  }

  if (typeof batch.freshness !== 'string' || !FRESHNESS.has(batch.freshness)) {
    throw new Error('ae-executive-batch-freshness')
  }

  const observed = validateBatchHeader(batch.projector, batch.scenes)
  const scenes = batch.scenes!.map(row => admitGenerationRow(row, observed))

  return {
    schema: 'ae-executive-scene-batch/2',
    authority: 'none',
    projector: batch.projector!,
    generation: batch.generation!,
    document_hash: batch.document_hash!,
    source_set_hash: batch.source_set_hash!,
    observed_ms: batch.observed_ms!,
    freshness: batch.freshness as AeExecutiveFreshness,
    scenes
  }
}

function validateSceneEnvelope(value: unknown): AeExecutiveSceneEnvelope {
  const envelope = value as Record<string, unknown>

  if (!['none', 'RUN_EXECUTIVE_COMPOSER'].includes(String(envelope.authority))) {
    throw new Error('ae-executive-envelope-authority')
  }

  if (!Number.isSafeInteger(envelope.executive_generation) || Number(envelope.executive_generation) < 0) {
    throw new Error('ae-executive-envelope-generation')
  }

  for (const field of ['document_hash', 'source_set_hash'] as const) {
    if (envelope[field] !== null && (typeof envelope[field] !== 'string' || !HASH_RE.test(envelope[field]))) {
      throw new Error(`ae-executive-envelope-${field.replaceAll('_', '-')}`)
    }
  }

  if (envelope.observed_ms !== null && (!Number.isSafeInteger(envelope.observed_ms) || Number(envelope.observed_ms) < 0)) {
    throw new Error('ae-executive-envelope-observed')
  }

  if (typeof envelope.freshness !== 'string' || !FRESHNESS.has(envelope.freshness)) {
    throw new Error('ae-executive-envelope-freshness')
  }

  if (typeof envelope.artifact_posture !== 'string' || !POSTURES.has(envelope.artifact_posture)) {
    throw new Error('ae-executive-envelope-artifact-posture')
  }

  if (typeof envelope.admission_code !== 'string' || !envelope.admission_code || envelope.admission_code.length > 256) {
    throw new Error('ae-executive-envelope-admission-code')
  }

  const blocker = admitEnvelopeBlocker(envelope.blocker)

  if (
    Number(envelope.executive_generation) === 0 && envelope.authority !== 'none' ||
    envelope.authority === 'RUN_EXECUTIVE_COMPOSER' && blocker !== null
  ) {
    throw new Error('ae-executive-envelope-authority')
  }

  const observed = validateBatchHeader('run::executive_composer', envelope.rows)
  const rows = envelope.rows as Array<Record<string, unknown>>
  const scenes = rows.map(row => admitEnvelopeRow(row, observed))

  return {
    schema: 'ae-executive-scene-envelope/1',
    authority: envelope.authority as AeExecutiveSceneEnvelope['authority'],
    executive_generation: Number(envelope.executive_generation),
    document_hash: envelope.document_hash as string | null,
    source_set_hash: envelope.source_set_hash as string | null,
    observed_ms: envelope.observed_ms as number | null,
    freshness: envelope.freshness as AeExecutiveFreshness,
    artifact_posture: envelope.artifact_posture as string,
    admission_code: envelope.admission_code,
    blocker,
    scenes
  }
}

function admitEnvelopeBlocker(value: unknown): AeExecutiveSceneEnvelope['blocker'] {
  if (value === null) {return null}

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ae-executive-envelope-blocker')
  }

  const blocker = value as Record<string, unknown>

  if (
    typeof blocker.code !== 'string' || !blocker.code || blocker.code.length > 256 ||
    typeof blocker.boundary !== 'string' || !blocker.boundary || blocker.boundary.length > 256 ||
    blocker.closed !== true
  ) {
    throw new Error('ae-executive-envelope-blocker')
  }

  return { code: blocker.code, boundary: blocker.boundary, closed: true }
}

function admitEnvelopeRow(row: Record<string, unknown>, observed: readonly string[]): AeExecutiveSceneRow {
  const tab = row.tab as string

  if (row.schema !== 'ae-executive-scene-row/1') {
    return { tab, state: 'unavailable', reason: 'ae-executive-row-schema' }
  }

  if (!Number.isSafeInteger(row.source_generation) || Number(row.source_generation) < 0) {
    return { tab, state: 'unavailable', reason: 'ae-executive-row-generation' }
  }

  if (row.source_hash !== null && (typeof row.source_hash !== 'string' || !HASH_RE.test(row.source_hash))) {
    return { tab, state: 'unavailable', reason: 'ae-executive-row-source-hash' }
  }

  if (row.observed_ms !== null && (!Number.isSafeInteger(row.observed_ms) || Number(row.observed_ms) < 0)) {
    return { tab, state: 'unavailable', reason: 'ae-executive-row-observed' }
  }

  if (
    typeof row.freshness !== 'string' || !FRESHNESS.has(row.freshness) ||
    typeof row.posture !== 'string' || !POSTURES.has(row.posture) ||
    typeof row.artifact_posture !== 'string' || !POSTURES.has(row.artifact_posture)
  ) {
    return { tab, state: 'unavailable', reason: 'ae-executive-row-posture' }
  }

  if (row.code !== null && (typeof row.code !== 'string' || row.code.length > 256)) {
    return { tab, state: 'unavailable', reason: 'ae-executive-row-code' }
  }

  const state: AeExecutiveTabState =
    row.scene === null || row.posture === 'unavailable' || row.posture === 'missing' || row.posture === 'held'
      ? 'unavailable'
      : row.posture === 'fixture'
        ? 'fixture'
        : row.posture === 'structural'
          ? 'structural'
          : row.freshness === 'stale'
            ? 'stale'
            : 'fresh'

  return admitGenerationRow({
    tab,
    state,
    ...(row.scene !== null ? { scene: row.scene as Record<string, unknown> } : {}),
    ...(row.code ? { reason: row.code as string } : {})
  }, observed)
}

function validateBatchHeader(
  projector: unknown,
  scenes: unknown
): string[] {
  if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > AE_EXECUTIVE_MAX_TABS) {
    throw new Error('ae-executive-batch-cardinality')
  }

  if (typeof projector !== 'string' || !projector) {
    throw new Error('ae-executive-batch-projector')
  }

  const observed = scenes.map(row =>
    row && typeof row === 'object' && !Array.isArray(row) ? (row as { tab?: unknown }).tab : undefined
  )

  if (observed.some(tab => typeof tab !== 'string' || !TAB_ID_RE.test(tab))) {
    throw new Error('ae-executive-tab-id')
  }

  if (new Set(observed).size !== observed.length) {throw new Error('ae-executive-tab-duplicate')}

  return observed as string[]
}

function admitGenerationRow(row: AeExecutiveSceneRow, observed: readonly string[]): AeExecutiveSceneRow {
  if (typeof row.state !== 'string' || !TAB_STATES.has(row.state)) {
    return { tab: row.tab, state: 'unavailable', reason: 'ae-executive-row-state' }
  }

  if (row.reason !== undefined && (typeof row.reason !== 'string' || row.reason.length > 256)) {
    return { tab: row.tab, state: 'unavailable', reason: 'ae-executive-row-reason' }
  }

  if (row.state === 'unavailable' && row.scene === undefined) {
    return { tab: row.tab, state: row.state, ...(row.reason ? { reason: row.reason } : {}) }
  }

  if (!row.scene || typeof row.scene !== 'object' || Array.isArray(row.scene)) {
    return { tab: row.tab, state: 'unavailable', reason: 'ae-executive-scene-invalid' }
  }

  try {
    validateExecutiveScene(row.scene, row.tab, observed)

    return {
      tab: row.tab,
      state: row.state,
      scene: row.scene,
      ...(row.reason ? { reason: row.reason } : {})
    }
  } catch (cause) {
    return {
      tab: row.tab,
      state: 'unavailable',
      reason: boundedExecutiveError(cause)
    }
  }
}

function validateExecutiveScene(
  scene: Record<string, unknown>,
  tab: string,
  observed: readonly string[]
): { handlers: string[]; hotkeys: string[] } {
  if (scene.sceneVersion !== '1.0.0' || typeof scene.root !== 'string' || !Array.isArray(scene.nodes)) {
    throw new Error('ae-executive-scene-schema')
  }

  if (scene.nodes.length === 0 || scene.nodes.length > 4096) {
    throw new Error('ae-executive-scene-bounds')
  }

  const nodes = validateExecutiveSceneGraph(scene, tab)

  const tabNodes = nodes.filter(node => {
    const tap = (node.on as Record<string, unknown> | undefined)?.tap

    return node.p === 'button' && typeof tap === 'string' && tap.startsWith('shell.tab.')
  })

  const handlers = tabNodes.map(node => (node.on as Record<string, string>).tap)

  for (const node of nodes) {
    const events = (node.on as Record<string, unknown> | undefined) ?? {}

    const shellEvents = Object.entries(events).filter(([, handler]) =>
      typeof handler === 'string' && handler.startsWith('shell.tab.')
    )

    if (!shellEvents.length) {continue}

    if (node.p !== 'button' || typeof events.tap !== 'string') {
      throw new Error(`ae-executive-shell-action-node:${tab}`)
    }

    if (shellEvents.some(([gesture, handler]) => !['key', 'tap'].includes(gesture) || handler !== events.tap)) {
      throw new Error(`ae-executive-shell-action-gesture:${tab}`)
    }
  }

  const workspaceTabs = handlers.map(handler => handler.slice('shell.tab.'.length))
  const allowedWorkspace = [...observed, ...AE_EXECUTIVE_HOST_DERIVED_TABS.filter(hostTab => !observed.includes(hostTab))]

  if (
    handlers.length < observed.length ||
    handlers.length > allowedWorkspace.length ||
    new Set(workspaceTabs).size !== workspaceTabs.length ||
    workspaceTabs.some((workspaceTab, index) => workspaceTab !== allowedWorkspace[index])
  ) {
    throw new Error(`ae-executive-shell-actions:${tab}`)
  }

  const hotkeys = tabNodes.map(node => {
    const label = (node.a as Record<string, unknown> | undefined)?.label
    const matches = typeof label === 'string' ? [...label.matchAll(/\[([A-Z0-9])\]/g)] : []

    if (matches.length !== 1) {throw new Error(`ae-executive-hotkey-label:${tab}`)}

    return matches[0][1]
  })

  if (new Set(hotkeys).size !== hotkeys.length) {
    throw new Error(`ae-executive-hotkey-collision:${tab}`)
  }

  if (typeof scene.id === 'string' && scene.id.startsWith('run-') && scene.id !== `run-${tab}`) {
    throw new Error(`ae-executive-card-identity:${tab}`)
  }

  return { handlers, hotkeys }
}

function validateExecutiveSceneGraph(scene: Record<string, unknown>, tab: string): Array<Record<string, unknown>> {
  const nodes = scene.nodes as Array<Record<string, unknown>>
  const byId = new Map<string, Record<string, unknown>>()

  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {throw new Error(`ae-executive-node:${tab}`)}

    if (typeof node.id !== 'string' || !SCENE_ID_RE.test(node.id) || byId.has(node.id)) {
      throw new Error(`ae-executive-node-id:${tab}`)
    }

    if (typeof node.p !== 'string' || !SCENE_PRIMITIVES.has(node.p)) {
      throw new Error(`ae-executive-primitive:${tab}`)
    }

    if (node.layout !== undefined) {
      if (!node.layout || typeof node.layout !== 'object' || Array.isArray(node.layout)) {
        throw new Error(`ae-executive-layout:${tab}`)
      }

      const layout = node.layout as Record<string, unknown>

      if (Object.keys(layout).some(key => key !== 'height')) {throw new Error(`ae-executive-layout:${tab}`)}

      if (
        layout.height !== undefined &&
        layout.height !== '*' &&
        (!Number.isSafeInteger(layout.height) || Number(layout.height) < 1 || Number(layout.height) > 4096)
      ) {throw new Error(`ae-executive-layout-height:${tab}`)}
    }

    if (node.kids !== undefined) {
      if (!Array.isArray(node.kids) || node.kids.some(id => typeof id !== 'string')) {
        throw new Error(`ae-executive-children:${tab}`)
      }

      if (!CONTAINER_PRIMITIVES.has(String(node.p)) && node.kids.length > 0) {
        throw new Error(`ae-executive-leaf-children:${tab}`)
      }
    }

    byId.set(node.id, node)
  }

  if (!byId.has(String(scene.root))) {throw new Error(`ae-executive-root-missing:${tab}`)}

  for (const node of nodes) {
    for (const child of (node.kids as string[] | undefined) ?? []) {
      if (!byId.has(child)) {throw new Error(`ae-executive-child-missing:${tab}`)}
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()

  const walk = (id: string, depth: number) => {
    if (depth > 64) {throw new Error(`ae-executive-scene-depth:${tab}`)}

    if (visiting.has(id)) {throw new Error(`ae-executive-scene-cycle:${tab}`)}

    if (visited.has(id)) {return}
    visiting.add(id)

    for (const child of (byId.get(id)?.kids as string[] | undefined) ?? []) {walk(child, depth + 1)}
    visiting.delete(id)
    visited.add(id)
  }

  walk(String(scene.root), 0)

  if (visited.size !== nodes.length) {throw new Error(`ae-executive-node-unreachable:${tab}`)}

  return nodes
}

function boundedExecutiveError(cause: unknown): string {
  return cause instanceof Error && /^ae-executive-[a-z0-9:-]{1,160}$/.test(cause.message)
    ? cause.message
    : 'admission-refused'
}

export function runAeExecutiveProjector(
  binary: string,
  artifactGeneration: string
): Promise<AeExecutiveBoundBatch> {
  if (!ARTIFACT_GENERATION_RE.test(artifactGeneration)) {
    return Promise.reject(new Error('ae-executive-artifact-generation'))
  }

  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [],
      { timeout: AE_EXECUTIVE_TIMEOUT_MS, maxBuffer: AE_EXECUTIVE_MAX_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) {return reject(new Error('ae-executive-projector-failed'))}

        try {
          const batch = validateAeExecutiveBatch(JSON.parse(String(stdout)))
          resolve({ ...batch, artifact_generation: artifactGeneration } as AeExecutiveBoundBatch)
        } catch (cause) {
          reject(new Error(`ae-executive-projector-invalid:${boundedExecutiveError(cause)}`))
        }
      }
    )
  })
}
