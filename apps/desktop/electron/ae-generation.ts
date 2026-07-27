import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const CURRENT_SCHEMA = 'costas-ae-current/1'
const MANIFEST_SCHEMA = 'costas-ae-generation/1'

const TOP_LEVEL = new Set([
  'ae-executive-scene',
  'ae-executive-scene.exe',
  'ae-skin-settings-scene',
  'ae-skin-settings-scene.exe',
  'butler',
  'butler.exe',
  'generation.json',
  'shell-viewport',
  'skins'
])

const sha256 = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

function readJson(file: string, maximum: number): { bytes: Buffer; value: Record<string, unknown> } {
  const stat = fs.lstatSync(file)

  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) {
    throw new Error('ae-generation-json-file')
  }

  const bytes = fs.readFileSync(file)
  const value: unknown = JSON.parse(bytes.toString('utf8'))

  if (!object(value)) {throw new Error('ae-generation-json-shape')}

  return { bytes, value }
}

function directoryReceipt(root: string) {
  const digest = createHash('sha256')
  let bytes = 0
  let files = 0

  const walk = (directory: string, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stat = fs.lstatSync(absolute)

      if (stat.isSymbolicLink()) {throw new Error('ae-generation-resource-symlink')}

      if (stat.isDirectory()) {walk(absolute, relative)}
      else if (stat.isFile()) {
        const content = fs.readFileSync(absolute)
        digest.update(relative)
        digest.update('\0')
        digest.update(content)
        digest.update('\0')
        bytes += content.length
        files += 1
      } else {throw new Error('ae-generation-resource-type')}
    }
  }

  walk(root)

  return { sha256: `sha256:${digest.digest('hex')}`, bytes, files }
}

export interface ResolvedAeGeneration {
  generationId: `sha256:${string}`
  root: string
  manifest: Record<string, unknown>
}

export function resolveAeGenerationRoot(storeRoot: string): ResolvedAeGeneration {
  const store = fs.realpathSync(storeRoot)
  const current = readJson(path.join(store, 'CURRENT.json'), 4096)

  if (
    !exact(current.value, ['schema', 'generation_id', 'manifest_sha256']) ||
    current.value.schema !== CURRENT_SCHEMA ||
    typeof current.value.generation_id !== 'string' ||
    !HASH_RE.test(current.value.generation_id) ||
    typeof current.value.manifest_sha256 !== 'string' ||
    !HASH_RE.test(current.value.manifest_sha256)
  ) {throw new Error('ae-generation-current')}

  const generationName = current.value.generation_id.slice('sha256:'.length)
  const generations = fs.realpathSync(path.join(store, 'generations'))
  const root = fs.realpathSync(path.join(generations, generationName))

  if (path.dirname(root) !== generations || fs.lstatSync(root).isSymbolicLink()) {
    throw new Error('ae-generation-confinement')
  }

  const manifestRead = readJson(path.join(root, 'generation.json'), 64 * 1024)

  if (sha256(manifestRead.bytes) !== current.value.manifest_sha256) {throw new Error('ae-generation-manifest-hash')}
  const manifest = manifestRead.value

  if (
    !exact(manifest, ['schema', 'generation_id', 'ae', 'costas', 'artifacts', 'resources', 'smoke']) ||
    manifest.schema !== MANIFEST_SCHEMA ||
    manifest.generation_id !== current.value.generation_id ||
    !Array.isArray(manifest.artifacts) ||
    !Array.isArray(manifest.resources)
  ) {throw new Error('ae-generation-manifest')}

  const generationPayload = {
    schema: manifest.schema,
    ae: manifest.ae,
    costas: manifest.costas,
    artifacts: manifest.artifacts,
    resources: manifest.resources,
    smoke: manifest.smoke
  }

  if (sha256(Buffer.from(JSON.stringify(generationPayload))) !== manifest.generation_id) {
    throw new Error('ae-generation-identity')
  }

  for (const raw of manifest.artifacts) {
    if (!object(raw) || typeof raw.name !== 'string' || typeof raw.sha256 !== 'string' || typeof raw.bytes !== 'number') {
      throw new Error('ae-generation-artifact-manifest')
    }

    const file = path.join(root, `${raw.name}${process.platform === 'win32' ? '.exe' : ''}`)
    const stat = fs.lstatSync(file)

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== raw.bytes || sha256(fs.readFileSync(file)) !== raw.sha256) {
      throw new Error(`ae-generation-artifact:${raw.name}`)
    }
  }

  for (const raw of manifest.resources) {
    if (!object(raw) || typeof raw.name !== 'string') {throw new Error('ae-generation-resource-manifest')}
    const observed = directoryReceipt(path.join(root, raw.name))

    if (observed.sha256 !== raw.sha256 || observed.bytes !== raw.bytes || observed.files !== raw.files) {
      throw new Error(`ae-generation-resource:${raw.name}`)
    }
  }

  if (fs.readdirSync(root).some(name => !TOP_LEVEL.has(name))) {throw new Error('ae-generation-extra-file')}

  return { generationId: current.value.generation_id as `sha256:${string}`, root, manifest }
}
