import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { type UguiDocument, validateUguiDocument } from '@hermes/shared/ugui-document'

const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/
const SAFE_NESTED_TARGET_RE = /^skin-(?:active-profile|profile-picker|evidence-[a-z0-9][a-z0-9-]{0,95})$/
const MAX_OUTPUT_BYTES = 1024 * 1024

export interface SkinSettingsDocumentResponse {
  schema: 'ae-skin-settings-document/1'
  authority: 'none'
  projector: string
  document: UguiDocument
}

export function resolveSkinSettingsDocumentBinary(generationRoot: string): string | null {
  const name = process.platform === 'win32' ? 'ae-skin-settings-document.exe' : 'ae-skin-settings-document'
  const candidate = path.join(generationRoot, name)

  try {
    return fs.statSync(candidate).isFile() ? candidate : null
  } catch {
    return null
  }
}

export function runSkinSettingsDocumentProjector(
  binary: string,
  request: { committed_id: string; preview_id: string }
): Promise<SkinSettingsDocumentResponse> {
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
          resolve(validateSkinSettingsDocument(JSON.parse(stdout)))
        } catch {
          reject(new Error('skin-settings-projector-invalid'))
        }
      }
    )

    child.stdin?.end(JSON.stringify({ schema: 'ae-skin-settings-request/1', ...request }))
  })
}

function collectActions(value: unknown, actions: string[]): void {
  if (Array.isArray(value)) {
    value.forEach(item => collectActions(item, actions))

    return
  }

  if (!value || typeof value !== 'object') {return}
  const item = value as Record<string, unknown>

  if (typeof item.action === 'string') {actions.push(item.action)}
  Object.values(item).forEach(child => collectActions(child, actions))
}

export function validateSkinSettingsDocument(value: unknown): SkinSettingsDocumentResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('skin-settings-response')
  }

  const row = value as Record<string, unknown>

  if (
    Object.keys(row).length !== 4 ||
    row.schema !== 'ae-skin-settings-document/1' ||
    row.authority !== 'none' ||
    typeof row.projector !== 'string' ||
    !row.projector ||
    !row.document ||
    typeof row.document !== 'object' ||
    Array.isArray(row.document)
  ) {
    throw new Error('skin-settings-schema')
  }

  const document = validateUguiDocument(row.document)
  const actions: string[] = []
  collectActions(document, actions)

  const skinActions = actions.filter(action => action.startsWith('skin.'))
  const presentationActions = actions.filter(action => action.startsWith('nested.toggle:'))

  if (
    !skinActions.includes('skin.apply') ||
    !skinActions.includes('skin.revert') ||
    !skinActions.some(action => action.startsWith('skin.preview.')) ||
    skinActions.some(action => !/^skin\.(?:apply|revert|preview\.[a-z0-9][a-z0-9-]{0,95})$/.test(action)) ||
    presentationActions.some(action => {
      const target = action.slice('nested.toggle:'.length)

      return !SAFE_NESTED_TARGET_RE.test(target)
    }) ||
    actions.length !== skinActions.length + presentationActions.length
  ) {
    throw new Error('skin-settings-actions')
  }

  return { ...row, document } as unknown as SkinSettingsDocumentResponse
}
