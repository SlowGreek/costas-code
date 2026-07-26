import type { AeExecutiveTabId } from './contract'

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

export interface AeExecutiveSceneBatch {
  readonly schema: 'ae-executive-scene-batch/1'
  readonly authority: 'none'
  readonly projector: string
  readonly scenes: ReadonlyArray<{ readonly tab: AeExecutiveTabId; readonly scene: AeExecutiveScene }>
}

let batchPromise: Promise<AeExecutiveSceneBatch> | null = null

export function loadExecutiveScenes(): Promise<AeExecutiveSceneBatch> {
  batchPromise ??= window.hermesDesktop.getAeExecutiveScenes().then(parseExecutiveBatch)

  return batchPromise
}

export function resetExecutiveScenesForTests() {
  batchPromise = null
}

export function sceneForTab(batch: AeExecutiveSceneBatch, tab: AeExecutiveTabId): AeExecutiveScene {
  const found = batch.scenes.find(row => row.tab === tab)

  if (!found) {throw new Error(`ae-executive-scene-missing:${tab}`)}

  return found.scene
}

export function parseExecutiveBatch(value: unknown): AeExecutiveSceneBatch {
  if (!value || typeof value !== 'object') {throw new Error('ae-executive-batch-invalid')}
  const batch = value as Partial<AeExecutiveSceneBatch>

  if (batch.schema !== 'ae-executive-scene-batch/1' || batch.authority !== 'none' || !Array.isArray(batch.scenes)) {
    throw new Error('ae-executive-batch-schema')
  }

  if (typeof batch.projector !== 'string' || !batch.projector || batch.scenes.length !== 9) {
    throw new Error('ae-executive-batch-projector')
  }

  const orderedTabs: readonly AeExecutiveTabId[] = [
    'home',
    'dashboard',
    'lucid',
    'quine',
    'scores',
    'metrics',
    'logs',
    'studio',
    'settings'
  ]

  for (const [index, row] of batch.scenes.entries()) {
    if (!row || typeof row !== 'object' || typeof row.tab !== 'string') {throw new Error('ae-executive-row-invalid')}

    if (row.tab !== orderedTabs[index]) {throw new Error('ae-executive-batch-order')}
    validateExecutiveScene(row.scene)
    validateSemanticExecutiveScene(row.scene, row.tab)
  }

  return batch as AeExecutiveSceneBatch
}

const EXECUTIVE_HANDLERS = [
  'shell.tab.home',
  'shell.tab.dashboard',
  'shell.tab.lucid',
  'shell.tab.quine',
  'shell.tab.scores',
  'shell.tab.metrics',
  'shell.tab.logs',
  'shell.tab.studio',
  'shell.tab.settings'
] as const

function validateSemanticExecutiveScene(scene: AeExecutiveScene, tab: AeExecutiveTabId) {
  const handlers = scene.nodes
    .flatMap(node => Object.values(node.on ?? {}))
    .filter(handler => handler.startsWith('shell.tab.'))

  if (
    handlers.length !== EXECUTIVE_HANDLERS.length ||
    handlers.some((handler, index) => handler !== EXECUTIVE_HANDLERS[index])
  ) {
    throw new Error(`ae-executive-shell-actions:${tab}`)
  }

  const cardScene = scene.id?.startsWith('run-') === true

  if (cardScene && scene.id !== `run-${tab}`) {throw new Error(`ae-executive-card-identity:${tab}`)}

  if (cardScene && !scene.nodes.some(node => node.layout?.height === '*')) {
    throw new Error(`ae-executive-elastic-layout:${tab}`)
  }

  for (const node of scene.nodes) {
    const text = typeof node.a?.text === 'string' ? node.a.text : ''
    const terminalShaped = text.includes(`${String.fromCharCode(27)}[`) || /[┌┐└┘├┤┬┴┼─│]/u.test(text)

    if (terminalShaped) {throw new Error(`ae-executive-terminal-text:${tab}`)}
  }
}

export function validateExecutiveScene(scene: AeExecutiveScene): readonly string[] {
  const errors: string[] = []
  const ids = new Set<string>()

  if (!scene || scene.sceneVersion !== '1.0.0' || typeof scene.root !== 'string' || !Array.isArray(scene.nodes)) {
    return ['scene-schema']
  }

  for (const node of scene.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id)) {
      errors.push(`node-id:${node?.id || 'empty'}`)

      continue
    }

    ids.add(node.id)
  }

  if (!ids.has(scene.root)) {errors.push('root-missing')}

  for (const node of scene.nodes) {
    if (node.kids?.some((id: string) => !ids.has(id))) {errors.push(`child-missing:${node.id}`)}
  }

  if (errors.length) {throw new Error(`ae-executive-scene-invalid:${errors.join(',')}`)}

  return errors
}
