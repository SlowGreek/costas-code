import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ATTRIBUTE_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const REQUEST_SCHEMA = 'ae-studio-designer-action/1'
const RECEIPT_SCHEMA = 'ae-studio-designer-action-receipt/1'
const MAX_BYTES = 16 * 1024
const TIMEOUT_MS = 3_000
const POLL_MS = 25

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

function validAction(action: string) {
  return action === 'studio.target.change' ||
    action === 'studio.evidence.toggle' ||
    action === 'studio.edit.undo' ||
    action === 'studio.edit.redo' ||
    action === 'studio.node.add' ||
    action === 'studio.node.remove' ||
    action === 'studio.node.move-up' ||
    action === 'studio.node.move-down' ||
    action === 'studio.element.select' ||
    (action.startsWith('studio.node.select.') && TOKEN_RE.test(action.slice('studio.node.select.'.length))) ||
    (action.startsWith('studio.property.') && ATTRIBUTE_RE.test(action.slice('studio.property.'.length)))
}

export interface StudioDesignerContext {
  revision: number
  documentHash: string
}

export interface StudioDesignerRequest {
  schema: 'ugui-scene-event/1'
  scene_id: string
  revision: number
  node_id: string
  gesture: 'change' | 'focus' | 'key' | 'submit' | 'tap'
  action: string
  payload: null | Record<string, unknown>
}

export interface StudioDesignerReceipt {
  schema: 'ae-studio-designer-action-receipt/1'
  operation_id: string
  status: 'accepted' | 'refused'
  code: string
  revision: number
  document_hash: string
  runtime_hash: string
  selected_node_id: string | null
}

export function studioDesignerContext(scene: unknown): StudioDesignerContext | null {
  if (!object(scene) || !object(scene.receipt) || !object(scene.receipt.editor)) {return null}
  const editor = scene.receipt.editor

  if (
    !Number.isSafeInteger(editor.revision) || Number(editor.revision) < 0 ||
    typeof editor.document_hash !== 'string' || !HASH_RE.test(editor.document_hash)
  ) {return null}

  return { revision: Number(editor.revision), documentHash: editor.document_hash }
}

export function validateStudioDesignerEvent(value: unknown): StudioDesignerRequest {
  if (!object(value) || !exact(value, ['schema', 'scene_id', 'revision', 'node_id', 'gesture', 'action', 'payload'])) {
    throw new Error('studio-event-shape')
  }

  if (
    value.schema !== 'ugui-scene-event/1' ||
    typeof value.scene_id !== 'string' || !TOKEN_RE.test(value.scene_id) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    typeof value.node_id !== 'string' || !TOKEN_RE.test(value.node_id) ||
    !['change', 'focus', 'key', 'submit', 'tap'].includes(String(value.gesture)) ||
    typeof value.action !== 'string' || !validAction(value.action) ||
    !(value.payload === null || object(value.payload))
  ) {throw new Error('studio-event-admission')}

  return value as unknown as StudioDesignerRequest
}

export function validateStudioDesignerReceipt(value: unknown, operationId: string): StudioDesignerReceipt {
  if (!object(value) || !exact(value, [
    'schema', 'operation_id', 'status', 'code', 'revision', 'document_hash', 'runtime_hash', 'selected_node_id'
  ])) {throw new Error('studio-receipt-shape')}

  if (
    value.schema !== RECEIPT_SCHEMA || value.operation_id !== operationId ||
    !['accepted', 'refused'].includes(String(value.status)) ||
    typeof value.code !== 'string' || !TOKEN_RE.test(value.code) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
    typeof value.document_hash !== 'string' || !HASH_RE.test(value.document_hash) ||
    typeof value.runtime_hash !== 'string' || !HASH_RE.test(value.runtime_hash) ||
    !(value.selected_node_id === null || typeof value.selected_node_id === 'string' && TOKEN_RE.test(value.selected_node_id))
  ) {throw new Error('studio-receipt-admission')}

  return value as unknown as StudioDesignerReceipt
}

function defaultStateRoot() {
  if (process.env.AE_RUN_STATE_DIR) {return path.resolve(process.env.AE_RUN_STATE_DIR)}

  if (process.platform === 'darwin') {return path.join(os.homedir(), 'Library', 'Application Support', 'ae')}

  if (process.platform === 'win32') {return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'ae')}

  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'ae')
}

function privateDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })

  if (process.platform !== 'win32') {fs.chmodSync(directory, 0o700)}
}

function atomicPrivateWrite(destination: string, bytes: Buffer) {
  if (bytes.length < 1 || bytes.length > MAX_BYTES) {throw new Error('studio-request-bounds')}
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.tmp`)
  const descriptor = fs.openSync(temporary, 'wx', 0o600)

  try {
    fs.writeFileSync(descriptor, bytes)
    fs.fsyncSync(descriptor)
  } finally {fs.closeSync(descriptor)}

  fs.renameSync(temporary, destination)
}

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

export async function submitStudioDesignerEvent(
  eventValue: unknown,
  context: StudioDesignerContext,
  options: { stateRoot?: string; operationId?: string; timeoutMs?: number } = {}
): Promise<StudioDesignerReceipt> {
  const event = validateStudioDesignerEvent(eventValue)

  if (!Number.isSafeInteger(context.revision) || context.revision < 0 || !HASH_RE.test(context.documentHash)) {
    throw new Error('studio-context-admission')
  }

  const operationId = options.operationId ?? `desktop-studio:${crypto.randomUUID()}`

  if (!TOKEN_RE.test(operationId)) {throw new Error('studio-operation-id')}
  const stateRoot = path.resolve(options.stateRoot ?? defaultStateRoot())
  const mailboxRoot = path.join(stateRoot, 'studio-actions')
  const inbox = path.join(mailboxRoot, 'inbox')
  const receipts = path.join(mailboxRoot, 'receipts')

  privateDirectory(stateRoot)
  privateDirectory(mailboxRoot)
  privateDirectory(inbox)
  privateDirectory(path.join(mailboxRoot, 'processing'))
  privateDirectory(receipts)

  const request = {
    schema: REQUEST_SCHEMA,
    operation_id: operationId,
    expected_revision: context.revision,
    expected_document_hash: context.documentHash,
    action: event.action,
    value: event.action === 'studio.element.select'
      ? event.node_id
      : typeof event.payload?.value === 'string' ? event.payload.value : null
  }

  atomicPrivateWrite(path.join(inbox, `${operationId}.json`), Buffer.from(JSON.stringify(request)))

  const receiptPath = path.join(receipts, `${operationId}.json`)
  const deadline = Date.now() + Math.min(Math.max(options.timeoutMs ?? TIMEOUT_MS, 100), TIMEOUT_MS)

  while (Date.now() <= deadline) {
    if (fs.existsSync(receiptPath)) {
      const stat = fs.lstatSync(receiptPath)

      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BYTES) {
        throw new Error('studio-receipt-file')
      }

      const receipt = validateStudioDesignerReceipt(JSON.parse(fs.readFileSync(receiptPath, 'utf8')), operationId)

      fs.unlinkSync(receiptPath)

      return receipt
    }

    await wait(POLL_MS)
  }

  throw new Error('studio-action-outcome-unknown')
}
