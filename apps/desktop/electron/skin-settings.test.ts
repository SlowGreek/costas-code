import { describe, expect, it } from 'vitest'

import { validateSkinSettingsScene } from './skin-settings'

interface TestNode {
  id: string
  p: string
  kids?: string[]
  a?: Record<string, unknown>
  on?: Record<string, string>
}

const scene = (): { sceneVersion: string; root: string; nodes: TestNode[] } => ({
  sceneVersion: '1.0.0',
  root: 'root',
  nodes: [
    { id: 'root', p: 'column', kids: ['preview', 'apply', 'revert'] },
    { id: 'preview', p: 'button', a: { label: 'Windows 95' }, on: { tap: 'skin.preview.windows-95' } },
    { id: 'apply', p: 'button', a: { label: 'Apply' }, on: { tap: 'skin.apply' } },
    { id: 'revert', p: 'button', a: { label: 'Revert' }, on: { tap: 'skin.revert' } }
  ]
})

describe('skin settings Scene admission', () => {
  it('admits only the closed standalone UGUI action codebook', () => {
    const value = {
      schema: 'ae-skin-settings-scene/1',
      authority: 'none',
      projector: 'ugui::theme::CATALOG->nested-card->ugui::project_checked',
      scene: scene()
    }

    expect(validateSkinSettingsScene(value)).toEqual(value)
  })

  it('admits closed nested presentation toggles only when their targets exist', () => {
    const nested = scene()
    nested.nodes[0].kids.push('nested')
    nested.nodes.push({
      id: 'nested',
      p: 'button',
      a: { label: 'Evidence' },
      on: { tap: 'nested.toggle:skin-active-profile' }
    })

    const value = {
      schema: 'ae-skin-settings-scene/1',
      authority: 'none',
      projector: 'ugui::theme::CATALOG->nested-card->ugui::project_checked',
      scene: nested
    }

    expect(validateSkinSettingsScene(value)).toEqual(value)
    nested.nodes[4].on!.tap = 'nested.toggle:missing'
    expect(() => validateSkinSettingsScene(value)).toThrow('skin-settings-actions')
  })

  it('rejects authority expansion, unsafe actions, invalid roots, and unknown primitives', () => {
    const base = {
      schema: 'ae-skin-settings-scene/1',
      authority: 'none',
      projector: 'test',
      scene: scene()
    }

    expect(() => validateSkinSettingsScene({ ...base, authority: 'skin' })).toThrow('skin-settings-schema')
    const action = structuredClone(base)
    action.scene.nodes[1].on!.tap = 'host.exec'
    expect(() => validateSkinSettingsScene(action)).toThrow('skin-settings-actions')
    expect(() => validateSkinSettingsScene({ ...base, scene: { ...scene(), root: 'missing' } })).toThrow('skin-settings-root')
    const primitive = structuredClone(base)
    primitive.scene.nodes[1].p = 'iframe'
    expect(() => validateSkinSettingsScene(primitive)).toThrow('skin-settings-node')
  })
})
