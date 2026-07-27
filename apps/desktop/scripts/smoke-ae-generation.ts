import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { validateAeExecutiveBatch } from '../electron/ae-executive'
import { resolveAeGenerationRoot } from '../electron/ae-generation'

const MAX_EXECUTIVE_BYTES = 2 * 1024 * 1024
const MAX_SKIN_SETTINGS_BYTES = 1024 * 1024
const suffix = process.platform === 'win32' ? '.exe' : ''

const sha256 = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

export function smokeAeGeneration(generationOrStoreDir: string) {
  const generationDir = fs.existsSync(path.join(generationOrStoreDir, 'CURRENT.json'))
    ? resolveAeGenerationRoot(generationOrStoreDir).root
    : generationOrStoreDir

  const binary = (name: string) => {
    const candidate = path.join(generationDir, `${name}${suffix}`)
    const stat = fs.statSync(candidate)

    if (!stat.isFile() || stat.size < 1) {throw new Error(`ae-generation-artifact:${name}`)}

    return candidate
  }

  const executiveBytes = execFileSync(binary('ae-executive-scene'), [], {
    encoding: 'utf8',
    maxBuffer: MAX_EXECUTIVE_BYTES,
    timeout: 15_000,
    windowsHide: true
  })

  const executive = validateAeExecutiveBatch(JSON.parse(executiveBytes))

  const executiveContract = {
    schema: executive.schema,
    authority: executive.authority,
    projector: executive.projector,
    scenes: executive.scenes.map(row => {
      const nodes = row.scene.nodes as Array<Record<string, unknown>>

      const tabButtons = nodes.filter(node => {
        const tap = (node.on as Record<string, unknown> | undefined)?.tap

        return node.p === 'button' && typeof tap === 'string' && tap.startsWith('shell.tab.')
      })

      return {
        tab: row.tab,
        scene_version: row.scene.sceneVersion,
        primitives: [...new Set(nodes.map(node => String(node.p)))].sort(),
        shell_actions: tabButtons.map(node => (node.on as Record<string, string>).tap),
        shell_labels: tabButtons.map(node => String((node.a as Record<string, unknown> | undefined)?.label || ''))
      }
    })
  }

  const skinBytes = execFileSync(binary('ae-skin-settings-scene'), [], {
    encoding: 'utf8',
    input: JSON.stringify({
      schema: 'ae-skin-settings-request/1',
      committed_id: 'glassmorphism',
      preview_id: 'windows-95'
    }),
    maxBuffer: MAX_SKIN_SETTINGS_BYTES,
    timeout: 15_000,
    windowsHide: true
  })

  const skin: unknown = JSON.parse(skinBytes)

  if (!skin || typeof skin !== 'object' || Array.isArray(skin)) {throw new Error('ae-generation-skin-response')}
  const response = skin as Record<string, unknown>

  if (
    response.schema !== 'ae-skin-settings-scene/1' ||
    response.authority !== 'none' ||
    !response.scene ||
    typeof response.scene !== 'object' ||
    !Array.isArray((response.scene as Record<string, unknown>).nodes)
  ) {
    throw new Error('ae-generation-skin-response')
  }

  const skinSettingsNodes = ((response.scene as Record<string, unknown>).nodes as unknown[]).length

  if (skinSettingsNodes < 1 || skinSettingsNodes > 4096) {throw new Error('ae-generation-skin-nodes')}

  execFileSync(binary('butler'), ['--version'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 15_000,
    windowsHide: true
  })

  return {
    executive_scenes: executive.scenes.length,
    executive_contract_sha256: sha256(JSON.stringify(executiveContract)),
    skin_settings_nodes: skinSettingsNodes
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const generationDir = process.argv[2]

  if (!generationDir) {throw new Error('usage: smoke-ae-generation.ts <generation-directory>')}
  process.stdout.write(`${JSON.stringify(smokeAeGeneration(path.resolve(generationDir)))}\n`)
}
