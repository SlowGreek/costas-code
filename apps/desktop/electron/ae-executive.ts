import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const AE_EXECUTIVE_MAX_BYTES = 2 * 1024 * 1024
export const AE_EXECUTIVE_TIMEOUT_MS = 15_000
export const AE_EXECUTIVE_TABS = ['home', 'dashboard', 'lucid', 'quine', 'scores', 'metrics', 'logs', 'studio', 'settings'] as const
export const AE_EXECUTIVE_MAX_TABS = 36

const SCENE_PRIMITIVES = new Set([
  'button', 'canvas', 'column', 'divider', 'image', 'input', 'native',
  'progress', 'row', 'select', 'spacer', 'stack', 'text'
])

const CONTAINER_PRIMITIVES = new Set(['column', 'row', 'stack'])
const SCENE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export interface AeExecutiveSceneBatch {
  schema: 'ae-executive-scene-batch/1'
  authority: 'none'
  projector: string
  scenes: Array<{ tab: string; scene: Record<string, unknown> }>
}

export function resolveAeExecutiveBinary(options: {
  isPackaged: boolean
  resourcesPath?: string
  sourceRepoRoot: string
  override?: string
}): string | null {
  const executable = process.platform === 'win32' ? 'ae-executive-scene.exe' : 'ae-executive-scene'

  const candidates = [
    options.override ? path.resolve(options.override) : null,
    options.isPackaged && options.resourcesPath ? path.join(options.resourcesPath, 'ae', executable) : null,
    !options.isPackaged
      ? path.resolve(options.sourceRepoRoot, '..', 'AgentExperiments', 'run', 'target', 'debug', executable)
      : null
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.find(candidate => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  }) ?? null
}

export function validateAeExecutiveBatch(value: unknown): AeExecutiveSceneBatch {
  if (!value || typeof value !== 'object') {throw new Error('ae-executive-batch-invalid')}
  const batch = value as Partial<AeExecutiveSceneBatch>

  if (batch.schema !== 'ae-executive-scene-batch/1' || batch.authority !== 'none') {
    throw new Error('ae-executive-batch-schema')
  }

  if (
    !Array.isArray(batch.scenes) ||
    batch.scenes.length < 1 ||
    batch.scenes.length > AE_EXECUTIVE_MAX_TABS
  ) {
    throw new Error('ae-executive-batch-cardinality')
  }

  if (typeof batch.projector !== 'string' || !batch.projector) {
    throw new Error('ae-executive-batch-projector')
  }

  const observed = batch.scenes.map(row => row?.tab)

  if (observed.some(tab => typeof tab !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(tab))) {
    throw new Error('ae-executive-tab-id')
  }

  if (new Set(observed).size !== observed.length) {throw new Error('ae-executive-tab-duplicate')}

  const legacy = !observed.includes('marketplace')

  if (legacy && observed.length !== AE_EXECUTIVE_TABS.length) {
    throw new Error('ae-executive-batch-cardinality')
  }

  if (legacy && AE_EXECUTIVE_TABS.some((tab, index) => observed[index] !== tab)) {
    throw new Error('ae-executive-batch-order')
  }

  let canonicalHotkeys: string[] | null = null

  for (const row of batch.scenes) {
    if (!row.scene || typeof row.scene !== 'object') {throw new Error('ae-executive-scene-invalid')}
    const scene = row.scene as Record<string, unknown>

    if (scene.sceneVersion !== '1.0.0' || typeof scene.root !== 'string' || !Array.isArray(scene.nodes)) {
      throw new Error('ae-executive-scene-schema')
    }

    if (scene.nodes.length === 0 || scene.nodes.length > 4096) {throw new Error('ae-executive-scene-bounds')}

    const nodes = validateExecutiveSceneGraph(scene, String(row.tab))

    const handlers = nodes
      .flatMap(node => Object.values((node.on as Record<string, unknown> | undefined) ?? {}))
      .filter(handler => typeof handler === 'string' && handler.startsWith('shell.tab.'))

    const expectedHandlers = observed.map(tab => `shell.tab.${tab}`)

    if (handlers.length !== expectedHandlers.length || handlers.some((handler, index) => handler !== expectedHandlers[index])) {
      throw new Error(`ae-executive-shell-actions:${row.tab}`)
    }

    const hotkeys = nodes
      .filter(node => {
        const tap = (node.on as Record<string, unknown> | undefined)?.tap

        return node.p === 'button' && typeof tap === 'string' && tap.startsWith('shell.tab.')
      })
      .map(node => {
        const label = (node.a as Record<string, unknown> | undefined)?.label
        const matches = typeof label === 'string' ? [...label.matchAll(/\[([A-Z0-9])\]/g)] : []

        if (matches.length !== 1) {throw new Error(`ae-executive-hotkey-label:${row.tab}`)}

        return matches[0][1]
      })

    if (new Set(hotkeys).size !== hotkeys.length) {throw new Error(`ae-executive-hotkey-collision:${row.tab}`)}

    if (canonicalHotkeys && hotkeys.some((hotkey, index) => hotkey !== canonicalHotkeys?.[index])) {
      throw new Error(`ae-executive-hotkey-drift:${row.tab}`)
    }

    canonicalHotkeys ??= hotkeys

    if (typeof scene.id === 'string' && scene.id.startsWith('run-')) {
      if (scene.id !== `run-${row.tab}`) {throw new Error(`ae-executive-card-identity:${row.tab}`)}
    }
  }

  return batch as AeExecutiveSceneBatch
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

export function runAeExecutiveProjector(binary: string): Promise<AeExecutiveSceneBatch> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [],
      { timeout: AE_EXECUTIVE_TIMEOUT_MS, maxBuffer: AE_EXECUTIVE_MAX_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) {return reject(new Error('ae-executive-projector-failed'))}

        try {
          resolve(validateAeExecutiveBatch(JSON.parse(String(stdout))))
        } catch {
          reject(new Error('ae-executive-projector-invalid'))
        }
      }
    )
  })
}
