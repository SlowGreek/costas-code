import { describe, expect, it } from 'vitest'

import { validateSkinSettingsDocument } from './skin-settings'

const document = () => ({
  id: 'hermes-skin-settings',
  type: 'skin-settings',
  header: [{ type: 'text', body: 'Skin projection', style: 'heading' }],
  sections: [
    {
      type: 'status_grid',
      items: [{ label: 'Preview', value: 'Windows 95', status: 'ok' }]
    }
  ],
  actions: [
    { id: 'preview', type: 'button', label: 'Windows 95', action: 'skin.preview.windows-95' },
    { id: 'apply', type: 'button', label: 'Apply', action: 'skin.apply' },
    { id: 'revert', type: 'button', label: 'Revert', action: 'skin.revert' }
  ]
})

describe('skin settings Document admission', () => {
  it('admits the canonical Document with the closed skin action codebook', () => {
    const value = {
      schema: 'ae-skin-settings-document/1',
      authority: 'none',
      projector: 'ugui::theme::CATALOG->nested-card->ugui::project_checked',
      document: document()
    }

    expect(validateSkinSettingsDocument(value)).toEqual(value)
  })

  it('admits only bounded nested presentation actions', () => {
    const nested = document()
    nested.actions.push({
      id: 'nested', type: 'button', label: 'Evidence', action: 'nested.toggle:skin-active-profile'
    })

    const value = {
      schema: 'ae-skin-settings-document/1',
      authority: 'none',
      projector: 'ugui::theme::CATALOG->nested-card->ugui::project_checked',
      document: nested
    }

    expect(validateSkinSettingsDocument(value)).toEqual(value)
    nested.actions[3].action = 'nested.toggle:missing'
    expect(() => validateSkinSettingsDocument(value)).toThrow('skin-settings-actions')
  })

  it('rejects authority expansion, unsafe actions, and retired Scene fields', () => {
    const base = {
      schema: 'ae-skin-settings-document/1',
      authority: 'none',
      projector: 'test',
      document: document()
    }

    expect(() => validateSkinSettingsDocument({ ...base, authority: 'skin' })).toThrow('skin-settings-schema')
    const action = structuredClone(base)
    action.document.actions[0].action = 'host.exec'
    expect(() => validateSkinSettingsDocument(action)).toThrow('skin-settings-actions')
    expect(() => validateSkinSettingsDocument({
      ...base,
      document: { ...document(), sceneVersion: '1.0.0', root: 'root', nodes: [] }
    })).toThrow('ugui-document-legacy')
  })
})
