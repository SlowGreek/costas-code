import { validateUguiDocument } from '@hermes/shared/ugui-document'
import { describe, expect, it } from 'vitest'

const document = () => ({
  id: 'example.document',
  type: 'document',
  header: [{ id: 'title', type: 'text', body: 'Example' }],
  sections: [{ type: 'status', signal: '🟢', body: 'Ready' }],
  actions: [{ id: 'continue', type: 'button', label: 'Continue', action: 'example.continue' }]
})

describe('shared UGUI Document admission', () => {
  it('admits the canonical semantic regions', () => {
    const value = document()

    expect(validateUguiDocument(value)).toBe(value)
  })

  it('rejects unreadable actions and retired Scene fields', () => {
    expect(() => validateUguiDocument({
      ...document(), actions: [{ id: '123', type: 'button', label: 'Invalid' }]
    })).toThrow('ugui-document-action-identity')
    expect(() => validateUguiDocument({
      ...document(), sceneVersion: '1.0.0', root: 'root', nodes: []
    })).toThrow('ugui-document-legacy')
  })
})
