import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { validateAeExecutiveDocumentEnvelope } from '../electron/ae-executive-document'
import { resolveAeGenerationRoot } from '../electron/ae-generation'
import { validateSkinSettingsDocument } from '../electron/skin-settings'

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

  const executiveBytes = execFileSync(binary('ae-executive-document'), [], {
    encoding: 'utf8',
    maxBuffer: MAX_EXECUTIVE_BYTES,
    timeout: 15_000,
    windowsHide: true
  })

  const executive = validateAeExecutiveDocumentEnvelope(JSON.parse(executiveBytes))
  const unavailableDocuments = executive.rows.filter(row => !row.document)

  if (executive.executive_generation > 0 && unavailableDocuments.length > 0) {
    throw new Error(
      `ae-generation-executive-documents-unavailable:${unavailableDocuments.map(row => row.tab).join(',')}`
    )
  }

  const executiveContract = {
    schema: executive.schema,
    authority: executive.authority,
    rows: executive.rows.map(row => {
      if (!row.document) {
        return { tab: row.tab, freshness: row.freshness, posture: row.posture, code: row.code }
      }

      const shellActions = row.document.actions
        .filter(action => action && typeof action === 'object' && !Array.isArray(action))
        .map(action => action as Record<string, unknown>)
        .filter(action => typeof action.action === 'string' && action.action.startsWith('shell.tab.'))

      return {
        tab: row.tab,
        document_type: row.document.type,
        regions: ['header', 'sections', 'actions'],
        item_types: [...new Set(
          [...row.document.header, ...row.document.sections, ...row.document.actions]
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => String((item as Record<string, unknown>).type || 'value'))
        )].sort(),
        shell_actions: shellActions.map(action => action.action),
        shell_labels: shellActions.map(action => String(action.label || ''))
      }
    })
  }

  const skinBytes = execFileSync(binary('ae-skin-settings-document'), [], {
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

  const skin = validateSkinSettingsDocument(JSON.parse(skinBytes))
  const countItems = (value: unknown): number => Array.isArray(value)
    ? value.length + value.reduce((total, item) => total + countItems(item), 0)
    : value && typeof value === 'object'
      ? Object.values(value).reduce((total, item) => total + countItems(item), 0)
      : 0
  const skinSettingsItems = countItems([
    ...skin.document.header,
    ...skin.document.sections,
    ...skin.document.actions
  ])

  if (skinSettingsItems < 1 || skinSettingsItems > 4096) {throw new Error('ae-generation-skin-items')}

  execFileSync(binary('butler'), ['--version'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 15_000,
    windowsHide: true
  })

  return {
    executive_documents: executive.rows.length,
    executive_contract_sha256: sha256(JSON.stringify(executiveContract)),
    skin_settings_items: skinSettingsItems
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const generationDir = process.argv[2]

  if (!generationDir) {throw new Error('usage: smoke-ae-generation.ts <generation-directory>')}
  process.stdout.write(`${JSON.stringify(smokeAeGeneration(path.resolve(generationDir)))}\n`)
}
