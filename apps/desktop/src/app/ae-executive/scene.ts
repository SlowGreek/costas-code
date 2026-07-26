import { AE_EXECUTIVE_TAB_IDS } from './contract'

const SCENE_PRIMITIVES = new Set<UgScenePrimitive>([
  'button', 'canvas', 'column', 'divider', 'image', 'input', 'native',
  'progress', 'row', 'select', 'spacer', 'stack', 'text'
])

const CONTAINER_PRIMITIVES = new Set<UgScenePrimitive>(['column', 'row', 'stack'])
const SCENE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

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
  readonly scenes: ReadonlyArray<{ readonly tab: string; readonly scene: AeExecutiveScene }>
}

let batchPromise: Promise<AeExecutiveSceneBatch> | null = null

export function loadExecutiveScenes(): Promise<AeExecutiveSceneBatch> {
  batchPromise ??= window.hermesDesktop.getAeExecutiveScenes().then(parseExecutiveBatch)

  return batchPromise
}

export function resetExecutiveScenesForTests() {
  batchPromise = null
}

export function sceneForTab(batch: AeExecutiveSceneBatch, tab: string): AeExecutiveScene {
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

  if (
    typeof batch.projector !== 'string' ||
    !batch.projector ||
    batch.scenes.length < 1 ||
    batch.scenes.length > 36
  ) {
    throw new Error('ae-executive-batch-projector')
  }

  const observed = batch.scenes.map(row => row?.tab)

  if (observed.some(tab => typeof tab !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(tab))) {
    throw new Error('ae-executive-tab-id')
  }

  if (new Set(observed).size !== observed.length) {throw new Error('ae-executive-tab-duplicate')}

  const legacy = !observed.includes('marketplace')

  if (legacy && observed.length !== AE_EXECUTIVE_TAB_IDS.length) {
    throw new Error('ae-executive-batch-cardinality')
  }

  if (legacy && AE_EXECUTIVE_TAB_IDS.some((tab, index) => observed[index] !== tab)) {
    throw new Error('ae-executive-batch-order')
  }

  let canonicalHotkeys: string[] | null = null

  for (const row of batch.scenes) {
    if (!row || typeof row !== 'object' || typeof row.tab !== 'string') {throw new Error('ae-executive-row-invalid')}
    validateExecutiveScene(row.scene)
    const hotkeys = validateSemanticExecutiveScene(row.scene, row.tab, observed)

    if (canonicalHotkeys && hotkeys.some((hotkey, index) => hotkey !== canonicalHotkeys?.[index])) {
      throw new Error(`ae-executive-hotkey-drift:${row.tab}`)
    }

    canonicalHotkeys ??= hotkeys
  }

  return batch as AeExecutiveSceneBatch
}

function validateSemanticExecutiveScene(scene: AeExecutiveScene, tab: string, tabs: readonly string[]) {
  const handlers = scene.nodes
    .flatMap(node => Object.values(node.on ?? {}))
    .filter(handler => handler.startsWith('shell.tab.'))

  if (
    handlers.length !== tabs.length ||
    handlers.some((handler, index) => handler !== `shell.tab.${tabs[index]}`)
  ) {
    throw new Error(`ae-executive-shell-actions:${tab}`)
  }

  const hotkeys = scene.nodes
    .filter(node => node.p === 'button' && node.on?.tap?.startsWith('shell.tab.'))
    .map(node => {
      const label = node.a?.label
      const matches = typeof label === 'string' ? [...label.matchAll(/\[([A-Z0-9])\]/g)] : []

      if (matches.length !== 1) {throw new Error(`ae-executive-hotkey-label:${tab}`)}

      return matches[0][1]
    })

  if (new Set(hotkeys).size !== hotkeys.length) {throw new Error(`ae-executive-hotkey-collision:${tab}`)}

  const cardScene = scene.id?.startsWith('run-') === true

  if (cardScene && scene.id !== `run-${tab}`) {throw new Error(`ae-executive-card-identity:${tab}`)}

  for (const node of scene.nodes) {
    const text = typeof node.a?.text === 'string' ? node.a.text : ''
    const terminalShaped = text.includes(`${String.fromCharCode(27)}[`) || /[┌┐└┘├┤┬┴┼─│]/u.test(text)

    if (terminalShaped) {throw new Error(`ae-executive-terminal-text:${tab}`)}
  }

  return hotkeys
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
