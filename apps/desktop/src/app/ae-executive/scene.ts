import { AE_EXECUTIVE_HOST_DERIVED_TAB_IDS, AE_EXECUTIVE_TAB_IDS } from './contract'

const SCENE_PRIMITIVES = new Set<UgScenePrimitive>([
  'button', 'canvas', 'column', 'divider', 'image', 'input', 'native',
  'progress', 'row', 'select', 'spacer', 'stack', 'text'
])

const CONTAINER_PRIMITIVES = new Set<UgScenePrimitive>(['column', 'row', 'stack'])
const SCENE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const TAB_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/
const HASH_RE = /^sha256:[0-9a-f]{64}$/
const FRESHNESS = new Set(['fresh', 'degraded', 'stale', 'unavailable'])
const TAB_STATES = new Set(['fresh', 'stale', 'unavailable', 'fixture', 'structural'])

export type UgScenePrimitive =
  | 'button'
  | 'canvas'
  | 'column'
  | 'divider'
  | 'image'
  | 'input'
  | 'native'
  | 'progress'
  | 'row'
  | 'select'
  | 'spacer'
  | 'stack'
  | 'text'

export interface UgSceneNode {
  readonly id: string
  readonly p: UgScenePrimitive
  readonly a?: Readonly<Record<string, unknown>>
  readonly kids?: readonly string[]
  readonly layout?: Readonly<{ height?: '*' | number }>
  readonly on?: Readonly<Record<string, string>>
}

export interface AeExecutiveScene {
  readonly sceneVersion: '1.0.0'
  readonly id?: string
  readonly root: string
  readonly nodes: readonly UgSceneNode[]
  readonly receipt?: Readonly<Record<string, unknown>>
}

export type AeExecutiveFreshness = 'fresh' | 'degraded' | 'stale' | 'unavailable' | 'unverified'
export type AeExecutivePosture = 'live' | 'degraded' | 'stale' | 'unavailable' | 'legacy-unverified'
export type AeExecutiveTabState = 'fresh' | 'stale' | 'unavailable' | 'fixture' | 'structural'

export interface AeExecutiveSceneRow {
  readonly tab: string
  readonly state: AeExecutiveTabState
  readonly scene?: AeExecutiveScene
  readonly reason?: string
  readonly preserved?: boolean
}

export interface AeExecutiveSceneBatch {
  readonly schema: 'ae-executive-scene-batch/1' | 'ae-executive-scene-batch/2'
  readonly authority: 'none'
  readonly projector: string
  readonly generation: number | null
  readonly document_hash: string | null
  readonly source_set_hash: string | null
  readonly observed_ms: number | null
  readonly freshness: AeExecutiveFreshness
  readonly artifact_generation: string
  readonly posture: AeExecutivePosture
  readonly scenes: readonly AeExecutiveSceneRow[]
}

export type ExecutiveReconcileResult =
  | { readonly accepted: true; readonly batch: AeExecutiveSceneBatch; readonly reason: 'accepted' | 'duplicate' }
  | { readonly accepted: false; readonly batch: AeExecutiveSceneBatch; readonly reason: string }

export function loadExecutiveScenes(): Promise<AeExecutiveSceneBatch> {
  return window.hermesDesktop.getAeExecutiveScenes().then(parseExecutiveBatch)
}

/** @deprecated The workspace reconciler owns every refresh; this alias remains for callers in migration. */
export function loadFreshExecutiveScenes(): Promise<AeExecutiveSceneBatch> {
  return loadExecutiveScenes()
}

export function resetExecutiveScenesForTests() {
  // There is deliberately no module-global settled Promise or renderer cache.
}

export function sceneForTab(batch: AeExecutiveSceneBatch, tab: string): AeExecutiveScene {
  const found = batch.scenes.find(row => row.tab === tab)

  if (!found?.scene) {throw new Error(found?.reason ?? `ae-executive-scene-missing:${tab}`)}

  return found.scene
}

export function parseExecutiveBatch(value: unknown): AeExecutiveSceneBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('ae-executive-batch-invalid')}
  const batch = value as Record<string, unknown>

  if (batch.schema === 'ae-executive-scene-batch/1') {return parseLegacyBatch(batch)}

  if (batch.schema === 'ae-executive-scene-batch/2') {return parseGenerationBatch(batch)}
  throw new Error('ae-executive-batch-schema')
}

function parseLegacyBatch(batch: Record<string, unknown>): AeExecutiveSceneBatch {
  if (batch.authority !== 'none' || !Array.isArray(batch.scenes)) {
    throw new Error('ae-executive-batch-schema')
  }

  const observed = validateBatchHeader(batch.projector, batch.scenes)
  const legacy = !observed.includes('marketplace')

  if (legacy && observed.length !== AE_EXECUTIVE_TAB_IDS.length - 3) {
    throw new Error('ae-executive-batch-cardinality')
  }

  const legacyTabs = AE_EXECUTIVE_TAB_IDS.filter(tab => !['github', 'marketplace', 'shell'].includes(tab))

  if (legacy && legacyTabs.some((tab, index) => observed[index] !== tab)) {
    throw new Error('ae-executive-batch-order')
  }

  const scenes = batch.scenes.map((raw, index) => {
    const row = raw as Record<string, unknown>
    const scene = row.scene as AeExecutiveScene

    validateExecutiveScene(scene)
    validateSemanticExecutiveScene(scene, observed[index], observed)

    return { tab: observed[index], state: 'structural' as const, scene }
  })

  return {
    schema: 'ae-executive-scene-batch/1',
    authority: 'none',
    projector: batch.projector as string,
    generation: null,
    document_hash: null,
    source_set_hash: null,
    observed_ms: null,
    freshness: 'unverified',
    artifact_generation: parseArtifactGeneration(batch.artifact_generation, true),
    posture: 'legacy-unverified',
    scenes
  }
}

function parseGenerationBatch(batch: Record<string, unknown>): AeExecutiveSceneBatch {
  if (batch.authority !== 'none' || !Array.isArray(batch.scenes)) {
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
  const scenes = batch.scenes.map((raw, index) => parseGenerationRow(raw, observed[index], observed))
  const freshness = batch.freshness as Exclude<AeExecutiveFreshness, 'unverified'>

  return {
    schema: 'ae-executive-scene-batch/2',
    authority: 'none',
    projector: batch.projector as string,
    generation: batch.generation as number,
    document_hash: batch.document_hash,
    source_set_hash: batch.source_set_hash,
    observed_ms: batch.observed_ms as number,
    freshness,
    artifact_generation: parseArtifactGeneration(batch.artifact_generation),
    posture: freshness === 'fresh' ? 'live' : freshness,
    scenes
  }
}

function validateBatchHeader(projector: unknown, scenes: unknown[]): string[] {
  if (typeof projector !== 'string' || !projector) {throw new Error('ae-executive-batch-projector')}

  if (scenes.length < 1 || scenes.length > 36) {throw new Error('ae-executive-batch-cardinality')}

  const observed = scenes.map(raw =>
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { tab?: unknown }).tab : undefined
  )

  if (observed.some(tab => typeof tab !== 'string' || !TAB_ID_RE.test(tab))) {
    throw new Error('ae-executive-tab-id')
  }

  if (new Set(observed).size !== observed.length) {throw new Error('ae-executive-tab-duplicate')}

  return observed as string[]
}

function parseArtifactGeneration(value: unknown, legacy = false): string {
  if (legacy && value === undefined) {return 'legacy-unbound'}

  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    throw new Error('ae-executive-artifact-generation')
  }

  return value
}

function parseGenerationRow(raw: unknown, tab: string, tabs: readonly string[]): AeExecutiveSceneRow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { tab, state: 'unavailable', reason: 'ae-executive-row-invalid' }
  }

  const row = raw as Record<string, unknown>

  if (typeof row.state !== 'string' || !TAB_STATES.has(row.state)) {
    return { tab, state: 'unavailable', reason: 'ae-executive-row-state' }
  }

  if (row.reason !== undefined && (typeof row.reason !== 'string' || row.reason.length > 256)) {
    return { tab, state: 'unavailable', reason: 'ae-executive-row-reason' }
  }

  if (row.state === 'unavailable' && row.scene === undefined) {
    return {
      tab,
      state: 'unavailable',
      ...(typeof row.reason === 'string' && row.reason ? { reason: row.reason } : {})
    }
  }

  try {
    const scene = row.scene as AeExecutiveScene

    validateExecutiveScene(scene)
    validateSemanticExecutiveScene(scene, tab, tabs)

    return {
      tab,
      state: row.state as AeExecutiveTabState,
      scene,
      ...(typeof row.reason === 'string' && row.reason ? { reason: row.reason } : {})
    }
  } catch (cause) {
    return { tab, state: 'unavailable', reason: boundedExecutiveError(cause) }
  }
}

export function reconcileExecutiveBatch(
  previous: AeExecutiveSceneBatch | null,
  incoming: AeExecutiveSceneBatch
): ExecutiveReconcileResult {
  if (!previous) {return { accepted: true, batch: incoming, reason: 'accepted' }}

  if (incoming.generation === null) {
    return { accepted: false, batch: previous, reason: 'legacy-unverified-not-live' }
  }

  if (previous.generation === null) {
    return { accepted: true, batch: incoming, reason: 'accepted' }
  }

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
    if (
      incoming.document_hash !== previous.document_hash ||
      incoming.source_set_hash !== previous.source_set_hash ||
      incoming.observed_ms !== previous.observed_ms ||
      incoming.freshness !== previous.freshness
    ) {
      return { accepted: false, batch: previous, reason: 'same-generation-conflict' }
    }

    return { accepted: true, batch: previous, reason: 'duplicate' }
  }

  if (incoming.document_hash === previous.document_hash) {
    return { accepted: false, batch: previous, reason: 'generation-hash-conflict' }
  }

  const previousRows = new Map(previous.scenes.map(row => [row.tab, row]))

  const nextRows = incoming.scenes.map(row => {
    if (row.scene && !['stale', 'unavailable'].includes(row.state)) {return row}
    const prior = previousRows.get(row.tab)

    return prior?.scene ? { ...row, scene: prior.scene, preserved: true } : row
  })

  return {
    accepted: true,
    reason: 'accepted',
    batch: { ...incoming, scenes: nextRows }
  }
}

function boundedExecutiveError(cause: unknown): string {
  return cause instanceof Error && /^ae-executive-[a-z0-9:-]{1,160}$/.test(cause.message)
    ? cause.message
    : 'admission-refused'
}

function validateSemanticExecutiveScene(
  scene: AeExecutiveScene,
  tab: string,
  tabs: readonly string[]
): { handlers: string[]; hotkeys: string[] } {
  const tabNodes = scene.nodes.filter(
    node => node.p === 'button' && node.on?.tap?.startsWith('shell.tab.')
  )

  const handlers = tabNodes.map(node => node.on!.tap!)

  for (const node of scene.nodes) {
    const shellEvents = Object.entries(node.on ?? {}).filter(([, handler]) => handler.startsWith('shell.tab.'))

    if (!shellEvents.length) {continue}

    if (node.p !== 'button' || !node.on?.tap?.startsWith('shell.tab.')) {
      throw new Error(`ae-executive-shell-action-node:${tab}`)
    }

    if (shellEvents.some(([gesture, handler]) => !['key', 'tap'].includes(gesture) || handler !== node.on?.tap)) {
      throw new Error(`ae-executive-shell-action-gesture:${tab}`)
    }
  }

  const workspaceTabs = handlers.map(handler => handler.slice('shell.tab.'.length))

  const allowedWorkspace = [
    ...tabs,
    ...AE_EXECUTIVE_HOST_DERIVED_TAB_IDS.filter(hostTab => !tabs.includes(hostTab))
  ]

  if (
    handlers.length < tabs.length ||
    handlers.length > allowedWorkspace.length ||
    new Set(workspaceTabs).size !== workspaceTabs.length ||
    workspaceTabs.some((workspaceTab, index) => workspaceTab !== allowedWorkspace[index])
  ) {
    throw new Error(`ae-executive-shell-actions:${tab}`)
  }

  const hotkeys = tabNodes.map(node => {
    const label = node.a?.label
    const matches = typeof label === 'string' ? [...label.matchAll(/\[([A-Z0-9])\]/g)] : []

    if (matches.length !== 1) {throw new Error(`ae-executive-hotkey-label:${tab}`)}

    return matches[0][1]
  })

  if (new Set(hotkeys).size !== hotkeys.length) {throw new Error(`ae-executive-hotkey-collision:${tab}`)}

  if (scene.id?.startsWith('run-') === true && scene.id !== `run-${tab}`) {
    throw new Error(`ae-executive-card-identity:${tab}`)
  }

  for (const node of scene.nodes) {
    const text = typeof node.a?.text === 'string' ? node.a.text : ''
    const terminalShaped = text.includes(`${String.fromCharCode(27)}[`) || /[┌┐└┘├┤┬┴┼─│]/u.test(text)

    if (terminalShaped) {throw new Error(`ae-executive-terminal-text:${tab}`)}
  }

  return { handlers, hotkeys }
}

export function validateExecutiveScene(scene: AeExecutiveScene): readonly string[] {
  const errors: string[] = []
  const nodes = Array.isArray(scene?.nodes) ? scene.nodes : []
  const byId = new Map<string, UgSceneNode>()

  if (!scene || scene.sceneVersion !== '1.0.0' || typeof scene.root !== 'string' || !Array.isArray(scene.nodes)) {
    throw new Error('ae-executive-scene-invalid:scene-schema')
  }

  if (nodes.length < 1 || nodes.length > 4096) {throw new Error('ae-executive-scene-invalid:scene-bounds')}

  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !SCENE_ID_RE.test(node.id) || byId.has(node.id)) {
      errors.push(`node-id:${node?.id || 'empty'}`)

      continue
    }

    if (!SCENE_PRIMITIVES.has(node.p)) {errors.push(`primitive:${node.id}`)}

    if (node.layout !== undefined) {
      if (Object.keys(node.layout).some(key => key !== 'height')) {errors.push(`layout:${node.id}`)}
      const height = node.layout.height

      if (
        height !== undefined &&
        height !== '*' &&
        (!Number.isSafeInteger(height) || Number(height) < 1 || Number(height) > 4096)
      ) {errors.push(`layout-height:${node.id}`)}
    }

    if (node.kids !== undefined) {
      if (!Array.isArray(node.kids) || node.kids.some((id: unknown) => typeof id !== 'string')) {
        errors.push(`children:${node.id}`)
      } else if (!CONTAINER_PRIMITIVES.has(node.p) && node.kids.length > 0) {
        errors.push(`leaf-children:${node.id}`)
      }
    }

    byId.set(node.id, node)
  }

  if (!byId.has(scene.root)) {errors.push('root-missing')}

  for (const node of nodes) {
    if (node.kids?.some((id: string) => !byId.has(id))) {errors.push(`child-missing:${node.id}`)}
  }

  if (!errors.length) {
    const visiting = new Set<string>()
    const visited = new Set<string>()

    const walk = (id: string, depth: number) => {
      if (depth > 64) {throw new Error('ae-executive-scene-invalid:scene-depth')}

      if (visiting.has(id)) {throw new Error('ae-executive-scene-invalid:scene-cycle')}

      if (visited.has(id)) {return}
      visiting.add(id)

      for (const child of byId.get(id)?.kids ?? []) {walk(child, depth + 1)}
      visiting.delete(id)
      visited.add(id)
    }

    walk(scene.root, 0)

    if (visited.size !== nodes.length) {errors.push('node-unreachable')}
  }

  if (errors.length) {throw new Error(`ae-executive-scene-invalid:${errors.join(',')}`)}

  return errors
}
