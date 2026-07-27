import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  studioDesignerContext,
  submitStudioDesignerEvent,
  validateStudioDesignerEvent,
  validateStudioDesignerReceipt
} from './studio-designer'

const roots: string[] = []
const hash = (value: string) => `sha256:${value.repeat(64)}`

function root() {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'costas-studio-designer-'))

  roots.push(value)

  return value
}

function event(action = 'studio.element.select') {
  return {
    schema: 'ugui-scene-event/1',
    scene_id: 'studio-scene',
    revision: 7,
    node_id: 'calculator-equals',
    gesture: 'tap',
    action,
    payload: { node_id: 'calculator-equals' }
  }
}

afterEach(() => {
  for (const value of roots.splice(0)) {fs.rmSync(value, { force: true, recursive: true })}
})

describe('Studio designer resident-owner mailbox', () => {
  it('writes one closed request and returns the exact RUN receipt', async () => {
    const stateRoot = root()
    const operationId = 'desktop-studio:test-1'

    const result = submitStudioDesignerEvent(
      event(),
      { revision: 4, documentHash: hash('a') },
      { stateRoot, operationId, timeoutMs: 500 }
    )

    const requestPath = path.join(stateRoot, 'studio-actions/inbox', `${operationId}.json`)
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'))

    expect(request).toEqual({
      schema: 'ae-studio-designer-action/1',
      operation_id: operationId,
      expected_revision: 4,
      expected_document_hash: hash('a'),
      action: 'studio.element.select',
      value: 'calculator-equals'
    })

    fs.writeFileSync(
      path.join(stateRoot, 'studio-actions/receipts', `${operationId}.json`),
      JSON.stringify({
        schema: 'ae-studio-designer-action-receipt/1',
        operation_id: operationId,
        status: 'accepted',
        code: 'studio-action-accepted',
        revision: 4,
        document_hash: hash('a'),
        runtime_hash: hash('b'),
        selected_node_id: 'calculator-equals'
      })
    )
    const receipt = await result

    expect(receipt.status).toBe('accepted')
    expect(receipt.selected_node_id).toBe('calculator-equals')
    expect(fs.existsSync(path.join(stateRoot, 'studio-actions/receipts', `${operationId}.json`))).toBe(false)
  })

  it('refuses unknown actions, malformed contexts, and mismatched receipts', () => {
    expect(() => validateStudioDesignerEvent(event('shell.exec'))).toThrow('studio-event-admission')
    expect(() => validateStudioDesignerReceipt({
      schema: 'ae-studio-designer-action-receipt/1',
      operation_id: 'wrong',
      status: 'accepted',
      code: 'ok',
      revision: 1,
      document_hash: hash('a'),
      runtime_hash: hash('b'),
      selected_node_id: null
    }, 'expected')).toThrow('studio-receipt-admission')
  })

  it('reads exact revision/hash only from Studio editor receipt', () => {
    expect(studioDesignerContext({
      receipt: { editor: { revision: 3, document_hash: hash('c') } }
    })).toEqual({ revision: 3, documentHash: hash('c') })
    expect(studioDesignerContext({
      receipt: { editor: { revision: -1, document_hash: hash('c') } }
    })).toBeNull()
    expect(studioDesignerContext({ receipt: {} })).toBeNull()
  })
})
