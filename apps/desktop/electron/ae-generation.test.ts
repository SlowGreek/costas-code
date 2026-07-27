import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveAeGenerationRoot } from './ae-generation'

const roots: string[] = []
const sha = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

function directoryReceipt(root: string) {
  const digest = createHash('sha256')
  let bytes = 0
  let files = 0

  const walk = (dir: string, prefix = '') => {
    for (const name of fs.readdirSync(dir).sort()) {
      const absolute = path.join(dir, name)
      const relative = prefix ? `${prefix}/${name}` : name

      if (fs.statSync(absolute).isDirectory()) {walk(absolute, relative)}
      else {
        const content = fs.readFileSync(absolute)
        digest.update(relative).update('\0').update(content).update('\0')
        bytes += content.length
        files += 1
      }
    }
  }

  walk(root)

  return { sha256: `sha256:${digest.digest('hex')}`, bytes, files }
}

function fixture() {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-generation-resolver-'))
  roots.push(store)
  let generation = path.join(store, 'generations', 'candidate')
  fs.mkdirSync(path.join(generation, 'skins'), { recursive: true })
  fs.mkdirSync(path.join(generation, 'shell-viewport'), { recursive: true })
  fs.writeFileSync(path.join(generation, 'skins', 'one.json'), '{}')
  fs.writeFileSync(path.join(generation, 'shell-viewport', 'one.json'), '{}')

  const artifacts = ['ae-executive-scene', 'ae-skin-settings-scene', 'butler'].map((name, index) => {
    const content = `binary-${index}`
    fs.writeFileSync(path.join(generation, name), content)

    return { name, sha256: sha(content), bytes: Buffer.byteLength(content) }
  })

  const manifest = {
    schema: 'costas-ae-generation/1',
    generation_id: '',
    ae: { root_realpath: '/ae', commit: 'b'.repeat(40), dirty: false, status_sha256: `sha256:${'c'.repeat(64)}` },
    costas: { root_realpath: '/costas', commit: 'e'.repeat(40), dirty: true, status_sha256: `sha256:${'f'.repeat(64)}` },
    artifacts,
    resources: [
      { name: 'shell-viewport', ...directoryReceipt(path.join(generation, 'shell-viewport')) },
      { name: 'skins', ...directoryReceipt(path.join(generation, 'skins')) }
    ],
    smoke: { executive_scenes: 10, executive_contract_sha256: `sha256:${'d'.repeat(64)}`, skin_settings_nodes: 78 }
  }

  const payload = {
    schema: manifest.schema,
    ae: manifest.ae,
    costas: manifest.costas,
    artifacts: manifest.artifacts,
    resources: manifest.resources,
    smoke: manifest.smoke
  }

  manifest.generation_id = sha(JSON.stringify(payload))
  const selected = path.join(store, 'generations', manifest.generation_id.slice('sha256:'.length))
  fs.renameSync(generation, selected)
  generation = selected
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`
  fs.writeFileSync(path.join(generation, 'generation.json'), manifestBytes)
  fs.writeFileSync(
    path.join(store, 'CURRENT.json'),
    `${JSON.stringify({ schema: 'costas-ae-current/1', generation_id: manifest.generation_id, manifest_sha256: sha(manifestBytes) }, null, 2)}\n`
  )

  return { store, generation, generationId: manifest.generation_id }
}

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { force: true, recursive: true })))

describe('AE immutable generation resolver', () => {
  it('resolves one complete selected generation', () => {
    const { store, generation, generationId } = fixture()
    expect(resolveAeGenerationRoot(store)).toMatchObject({ generationId, root: fs.realpathSync(generation) })
  })

  it('rejects artifact tampering, pointer tampering, extras, and symlink resources', () => {
    let value = fixture()
    fs.writeFileSync(path.join(value.generation, 'butler'), 'tampered')
    expect(() => resolveAeGenerationRoot(value.store)).toThrow('ae-generation-artifact:butler')

    value = fixture()
    fs.writeFileSync(path.join(value.store, 'CURRENT.json'), '{}')
    expect(() => resolveAeGenerationRoot(value.store)).toThrow('ae-generation-current')

    value = fixture()
    fs.writeFileSync(path.join(value.generation, 'extra'), 'x')
    expect(() => resolveAeGenerationRoot(value.store)).toThrow('ae-generation-extra-file')

    value = fixture()
    fs.rmSync(path.join(value.generation, 'skins', 'one.json'))
    fs.symlinkSync('/tmp', path.join(value.generation, 'skins', 'bad'))
    expect(() => resolveAeGenerationRoot(value.store)).toThrow('ae-generation-resource-symlink')
  })
})
