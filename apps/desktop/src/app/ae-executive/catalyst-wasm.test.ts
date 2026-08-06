// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  mountDocument,
  setWasmInputForTests,
  tabDocument,
  tabsJson,
  uguiActionFromClick
} from './catalyst-wasm'

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
      itemId: 'home-tab-dashboard',
      source: null
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

describe('authored tab set', () => {
  it('publishes TABS.json and paints the MICROSOFT keystone from the projects catalog', async () => {
    const root = window.document.createElement('div')

    window.document.body.append(root)
    const catalog = JSON.parse(await tabsJson()) as {
      tabs: { id: string; source: string; app: string; live: boolean }[]
    }
    const keystone = catalog.tabs.find(tab => tab.id === 'microsoft')

    expect(keystone).toMatchObject({ source: 'projects', app: 'projects.microsoft', live: false })

    await mountDocument(root, JSON.parse(await tabDocument('microsoft')))
    // Rich vocabulary no RUN-composed tab exercises.
    expect(root.querySelector('img')).not.toBeNull()
    expect(root.querySelector('select')).not.toBeNull()
    expect(root.querySelector('input')).not.toBeNull()
    expect(root.getAttribute('data-ugui-painter')).toBe('rust-wasm')
  })

  it('refuses a live RUN tab as a static document', async () => {
    await expect(tabDocument('dashboard')).resolves.toContain('E_CATALYST_TAB_DOCUMENT')
  })
})
