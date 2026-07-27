import { createHash } from 'node:crypto'
import fs from 'node:fs'

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const COMMIT_RE = /^[0-9a-f]{40}$/
const REQUIRED_ARTIFACTS = ['ae-executive-scene', 'ae-skin-settings-scene', 'butler']

const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const exact = (value, keys) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key))

export function computeAeGenerationId(value) {
  const payload = {
    schema: value.schema,
    ae: value.ae,
    costas: value.costas,
    artifacts: value.artifacts,
    resources: value.resources,
    smoke: value.smoke
  }
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`
}

function validateRepositoryIdentity(name, value) {
  if (!exact(value, ['root_realpath', 'commit', 'dirty', 'status_sha256'])) {
    throw new Error(`generation-${name}-fields`)
  }
  if (
    typeof value.root_realpath !== 'string' ||
    !value.root_realpath.startsWith('/') ||
    !COMMIT_RE.test(value.commit) ||
    typeof value.dirty !== 'boolean' ||
    !HASH_RE.test(value.status_sha256)
  ) {
    throw new Error(`generation-${name}`)
  }
}

export function validateAeGenerationManifest(value) {
  if (!exact(value, ['schema', 'generation_id', 'ae', 'costas', 'artifacts', 'resources', 'smoke'])) {
    throw new Error('generation-fields')
  }
  if (value.schema !== 'costas-ae-generation/1') throw new Error('generation-schema')
  if (!HASH_RE.test(value.generation_id)) throw new Error('generation-hash')
  validateRepositoryIdentity('ae', value.ae)
  validateRepositoryIdentity('costas', value.costas)
  if (!Array.isArray(value.artifacts) || value.artifacts.length !== REQUIRED_ARTIFACTS.length) {
    throw new Error('generation-artifacts')
  }
  const names = []
  for (const artifact of value.artifacts) {
    if (!exact(artifact, ['name', 'sha256', 'bytes'])) throw new Error('generation-artifact-fields')
    if (
      !REQUIRED_ARTIFACTS.includes(artifact.name) ||
      !HASH_RE.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 1 ||
      artifact.bytes > 512 * 1024 * 1024
    ) {
      throw new Error('generation-artifact')
    }
    names.push(artifact.name)
  }
  if (new Set(names).size !== names.length || REQUIRED_ARTIFACTS.some(name => !names.includes(name))) {
    throw new Error('generation-artifacts')
  }
  if (!Array.isArray(value.resources) || value.resources.length !== 2) throw new Error('generation-resources')
  const resourceNames = []
  for (const resource of value.resources) {
    if (!exact(resource, ['name', 'sha256', 'files', 'bytes'])) throw new Error('generation-resource-fields')
    if (
      !['shell-viewport', 'skins'].includes(resource.name) ||
      !HASH_RE.test(resource.sha256) ||
      !Number.isSafeInteger(resource.files) ||
      resource.files < 1 ||
      resource.files > 4096 ||
      !Number.isSafeInteger(resource.bytes) ||
      resource.bytes < 1 ||
      resource.bytes > 16 * 1024 * 1024
    ) throw new Error('generation-resource')
    resourceNames.push(resource.name)
  }
  if (new Set(resourceNames).size !== 2) throw new Error('generation-resources')
  if (!exact(value.smoke, ['executive_scenes', 'executive_contract_sha256', 'skin_settings_nodes'])) {
    throw new Error('generation-smoke-fields')
  }
  if (
    !Number.isSafeInteger(value.smoke.executive_scenes) ||
    value.smoke.executive_scenes < 1 ||
    value.smoke.executive_scenes > 36 ||
    !HASH_RE.test(value.smoke.executive_contract_sha256) ||
    !Number.isSafeInteger(value.smoke.skin_settings_nodes) ||
    value.smoke.skin_settings_nodes < 1 ||
    value.smoke.skin_settings_nodes > 4096
  ) {
    throw new Error('generation-smoke')
  }
  if (value.generation_id !== computeAeGenerationId(value)) throw new Error('generation-identity')
  return value
}

export function reconcileAeOrphans({ buildRoot, isAlive = pid => {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code !== 'ESRCH' }
} }) {
  const removed = []
  for (const name of fs.readdirSync(buildRoot)) {
    const match = name.match(/^\.ae-(?:candidate|cargo)-(\d+)-(\d+)$/)
    if (!match) continue
    const target = `${buildRoot}/${name}`
    const metadata = fs.lstatSync(target)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error('generation-orphan-type')
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid < 1 || isAlive(pid)) continue
    fs.rmSync(target, { force: true, recursive: true })
    removed.push(name)
  }
  return removed.sort()
}

export function publishAeGeneration({
  candidateDir,
  destinationDir,
  validateCandidate,
  rename = fs.renameSync,
  remove = target => fs.rmSync(target, { force: true, recursive: true })
}) {
  if (typeof candidateDir !== 'string' || typeof destinationDir !== 'string' || candidateDir === destinationDir) {
    throw new Error('generation-path')
  }
  if (!fs.statSync(candidateDir).isDirectory()) throw new Error('generation-candidate')

  validateCandidate(candidateDir)

  const backupDir = `${destinationDir}.previous-${process.pid}-${Date.now()}`
  remove(backupDir)
  const hadPrevious = fs.existsSync(destinationDir)
  if (hadPrevious) rename(destinationDir, backupDir)

  try {
    rename(candidateDir, destinationDir)
  } catch (error) {
    if (hadPrevious && fs.existsSync(backupDir) && !fs.existsSync(destinationDir)) {
      rename(backupDir, destinationDir)
    }
    throw error
  }

  remove(backupDir)
  return destinationDir
}

export function publishAeGenerationStore({
  candidateDir,
  storeDir,
  manifest,
  validateCandidate,
  rename = fs.renameSync,
  write = fs.writeFileSync
}) {
  validateAeGenerationManifest(manifest)
  validateCandidate(candidateDir)
  const generationName = manifest.generation_id.slice('sha256:'.length)
  const generationsDir = `${storeDir}/generations`
  const generationDir = `${generationsDir}/${generationName}`
  fs.mkdirSync(generationsDir, { recursive: true })

  if (fs.existsSync(generationDir)) {
    validateCandidate(generationDir)
    fs.rmSync(candidateDir, { force: true, recursive: true })
  } else {
    rename(candidateDir, generationDir)
  }

  const manifestBytes = fs.readFileSync(`${generationDir}/generation.json`)
  const manifestSha256 = `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`
  const pointer = {
    schema: 'costas-ae-current/1',
    generation_id: manifest.generation_id,
    manifest_sha256: manifestSha256
  }
  const pointerBytes = `${JSON.stringify(pointer, null, 2)}\n`
  const temporary = `${storeDir}/.CURRENT.${process.pid}.${Date.now()}.tmp`
  write(temporary, pointerBytes, { mode: 0o600 })
  rename(temporary, `${storeDir}/CURRENT.json`)

  const observed = JSON.parse(fs.readFileSync(`${storeDir}/CURRENT.json`, 'utf8'))
  if (JSON.stringify(observed) !== JSON.stringify(pointer)) throw new Error('generation-current-readback')
  return { generationDir, pointer }
}
