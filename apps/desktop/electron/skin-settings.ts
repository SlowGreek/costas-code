import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/
const MAX_OUTPUT_BYTES = 1024 * 1024

const SCENE_PRIMITIVES = new Set([
  'button',
  'canvas',
  'column',
  'divider',
  'image',
  'input',
  'native',
  'progress',
  'row',
  'select',
  'spacer',
  'stack',
  'text'
])

export interface SkinSettingsSceneResponse {
  schema: 'ae-skin-settings-scene/1'
  authority: 'none'
  projector: string
  scene: Record<string, unknown>
}

export function resolveSkinSettingsBinary(options: {
  isPackaged: boolean
  resourcesPath?: string
  appRoot: string
}): string | null {
  const name = process.platform === 'win32' ? 'ae-skin-settings-scene.exe' : 'ae-skin-settings-scene'

  const candidate =
    options.isPackaged && options.resourcesPath
      ? path.join(options.resourcesPath, 'ae', name)
      : path.join(options.appRoot, 'build', 'ae', name)

  try {
    return fs.statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

export function runSkinSettingsProjector(
  binary: string,
  request: { committed_id: string; preview_id: string }
): Promise<SkinSettingsSceneResponse> {
  if (!SAFE_ID_RE.test(request.committed_id) || !SAFE_ID_RE.test(request.preview_id)) {
    return Promise.reject(new Error('skin-settings-id'))
  }

  return new Promise((resolve, reject) => {
    const child = execFile(
      binary,
      [],
      { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
          reject(new Error('skin-settings-projector-failed'))

          return
        }

        try {
          resolve(validateSkinSettingsScene(JSON.parse(stdout)))
        } catch {
          reject(new Error('skin-settings-projector-invalid'))
        }
      }
    )

    child.stdin?.end(JSON.stringify({ schema: 'ae-skin-settings-request/1', ...request }))
  })
}

function validateStandaloneScene(scene: Record<string, unknown>): void {
  if (
    scene.sceneVersion !== '1.0.0' ||
    typeof scene.root !== 'string' ||
    !Array.isArray(scene.nodes) ||
    scene.nodes.length < 1 ||
    scene.nodes.length > 2_048
  ) {
    throw new Error('skin-settings-scene')
  }

  const ids = new Set<string>()

  for (const raw of scene.nodes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('skin-settings-node')
    }

    const node = raw as Record<string, unknown>

    if (
      typeof node.id !== 'string' ||
      !SAFE_ID_RE.test(node.id) ||
      ids.has(node.id) ||
      typeof node.p !== 'string' ||
      !SCENE_PRIMITIVES.has(node.p)
    ) {
      throw new Error('skin-settings-node')
    }

    ids.add(node.id)
  }

  if (!ids.has(scene.root)) {
    throw new Error('skin-settings-root')
  }

  for (const raw of scene.nodes as Array<Record<string, unknown>>) {
    if (
      raw.kids !== undefined &&
      (!Array.isArray(raw.kids) || raw.kids.some(id => typeof id !== 'string' || !ids.has(id)))
    ) {
      throw new Error('skin-settings-child')
    }
  }
}

export function validateSkinSettingsScene(value: unknown): SkinSettingsSceneResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('skin-settings-response')
  }

  const row = value as Record<string, unknown>

  if (
    Object.keys(row).length !== 4 ||
    row.schema !== 'ae-skin-settings-scene/1' ||
    row.authority !== 'none' ||
    typeof row.projector !== 'string' ||
    !row.projector ||
    !row.scene ||
    typeof row.scene !== 'object' ||
    Array.isArray(row.scene)
  ) {
    throw new Error('skin-settings-schema')
  }

  const scene = row.scene as Record<string, unknown>
  validateStandaloneScene(scene)
  const nodes = scene.nodes as Array<Record<string, unknown>>

  const actions = nodes
    .flatMap(node => Object.values((node as { on?: Record<string, unknown> }).on ?? {}))
    .filter((action): action is string => typeof action === 'string')

  if (
    !actions.includes('skin.apply') ||
    !actions.includes('skin.revert') ||
    !actions.some(action => action.startsWith('skin.preview.')) ||
    actions.some(action => !/^skin\.(?:apply|revert|preview\.[a-z0-9][a-z0-9-]{0,95})$/.test(action))
  ) {
    throw new Error('skin-settings-actions')
  }

  return row as unknown as SkinSettingsSceneResponse
}
