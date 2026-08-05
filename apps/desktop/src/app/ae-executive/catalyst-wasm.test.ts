// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { mountDocument, setWasmInputForTests, uguiActionFromClick } from './catalyst-wasm'

const document = {
  id: 'run-home',
  type: 'document',
  header: [{ id: 'home-heading', type: 'text', body: 'RUN HOME', style: 'heading' }],
  sections: [
    { id: 'home-status', type: 'status_grid', items: [{ label: 'State', value: 'Ready', status: 'ok' }] }
  ],
  actions: [
    { id: 'home-tab-dashboard', type: 'button', label: '[D]ASHBOARD', action: 'shell.tab.dashboard' }
  ]
}

beforeAll(() => {
  setWasmInputForTests(readFileSync(resolve(process.cwd(), 'public/wasm/catalyst_wasm_bg.wasm')))
})

describe('catalyst UGUI client', () => {
  it('paints a canonical Document into the host element', async () => {
    const root = window.document.createElement('div')

    window.document.body.append(root)
    await mountDocument(root, document)

    expect(root.getAttribute('data-ugui-painter')).toBe('rust-wasm')
    expect(root.textContent).toContain('RUN HOME')
    expect(root.querySelector('[data-ugui-action="shell.tab.dashboard"]')).not.toBeNull()
  })

  it('resolves the action a click landed on', async () => {
    const root = window.document.createElement('div')

    window.document.body.append(root)
    await mountDocument(root, document)

    const button = root.querySelector('[data-ugui-action="shell.tab.dashboard"]')

    expect(uguiActionFromClick(button)).toEqual({
      action: 'shell.tab.dashboard',
      itemId: 'home-tab-dashboard'
    })
    expect(uguiActionFromClick(root)).toBeNull()
  })

  it('refuses a Document the engine does not admit', async () => {
    const root = window.document.createElement('div')

    window.document.body.append(root)
    await expect(mountDocument(root, { id: 'x', sceneVersion: 1 })).rejects.toThrow(
      /E_CATALYST_UGUI/
    )
  })
})
