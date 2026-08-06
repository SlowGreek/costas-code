// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  mountDocument,
  globalKey,
  preferenceSelection,
  preferenceVocabulary,
  projectsInput,
  skinField,
  setAssetBaseForTests,
  setWasmInputForTests,
  tabDocument,
  tabsJson,
  uguiActionFromEvent
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

    expect(uguiActionFromEvent(button, 'click')).toEqual({
      action: 'shell.tab.dashboard',
      itemId: 'home-tab-dashboard',
      source: null,
      value: null
    })
    expect(uguiActionFromEvent(root, 'click')).toBeNull()
  })

  it('hears a select on change rather than on click, and carries its value', async () => {
    const root = window.document.createElement('div')

    window.document.body.append(root)
    await mountDocument(root, {
      ...document,
      id: 'skins',
      actions: [
        {
          id: 'projects.skins.select',
          type: 'select',
          label: 'Skin',
          action: 'projects.skin.select',
          value: 'glassmorphism',
          choices: [
            { label: 'Glassmorphism', value: 'glassmorphism' },
            { label: 'Windows XP', value: 'winxp' }
          ]
        }
      ]
    })

    const select = root.querySelector<HTMLSelectElement>('[data-ugui-action="projects.skin.select"]')

    expect(select).not.toBeNull()
    expect(select?.getAttribute('data-ugui-gesture')).toBe('change')
    // A dropdown never commits on click, which is why it used to do nothing.
    expect(uguiActionFromEvent(select, 'click')).toBeNull()

    select!.value = 'winxp'

    expect(uguiActionFromEvent(select, 'change')?.value).toBe('winxp')
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

it('resolves Document assets against the host base, not the filesystem root', async () => {
  const root = window.document.createElement('div')

  window.document.body.append(root)
  await mountDocument(root, {
    id: 'assets',
    type: 'document',
    header: [],
    sections: [
      { id: 'brand', type: 'image', source: '/png/settings.svg', alt: 'Settings' }
    ],
    actions: []
  })

  // jsdom serves http, so the site root stays the base and the URL is untouched.
  expect(root.querySelector('img')?.getAttribute('src')).toBe('/png/settings.svg')

  setAssetBaseForTests('file:///Applications/Catalyst.app/dist/')
  const rebased = window.document.createElement('div')

  window.document.body.append(rebased)
  // Every item that names an asset, not just images: a missed painter site is
  // a broken icon in a packaged build.
  await mountDocument(rebased, {
    id: 'assets',
    type: 'document',
    header: [
      { id: 'brand', type: 'image', source: '/png/settings.svg', alt: 'Settings' },
      {
        id: 'gear',
        type: 'nested-card',
        label: 'Settings',
        iconSource: '/png/settings.svg',
        source: '/apps/settings.json'
      }
    ],
    sections: [
      {
        id: 'vertical',
        type: 'button',
        label: 'Xbox',
        action: 'projects.applet.input.facet-domain',
        source: '/png/xbox.svg'
      }
    ],
    actions: []
  })

  const painted = [...rebased.querySelectorAll('img')].map(image => image.getAttribute('src'))

  expect(painted).toEqual([
    'file:///Applications/Catalyst.app/dist/png/settings.svg',
    'file:///Applications/Catalyst.app/dist/png/settings.svg',
    'file:///Applications/Catalyst.app/dist/png/xbox.svg'
  ])
  setAssetBaseForTests('/')
})

it('drives the seated Projects applet through the engine reducer', () => {
  // The engine owns the reducer; this host only carries the input and repaints.
  const filtered = projectsInput('projects.applet.input.facet-hat', 'projects-hat', 'architect')

  expect(filtered.status).toBe('accepted')
  // The corpus ships with the engine, so this host filters real records rather
  // than painting an empty board.
  expect(JSON.stringify(filtered.document)).toMatch(/one-pager|proposal|record|projects/i)

  const searched = projectsInput('projects.applet.input.search', 'projects-search', 'agents')

  expect(searched.status).toBe('accepted')

  // A handler the query does not own is refused, not silently applied.
  const refused = projectsInput('projects.inspector.field', 'node', null)

  expect(refused.error).toBe('E_CATALYST_PROJECTS_HOST_INPUT')
})


it('answers what a keystroke means from the engine, not from this host', () => {
  // The projects client and this one must agree on every key, so neither
  // invents a meaning the other does not have.
  expect(globalKey('/', { meta: false, control: false, alt: false }).kind).toBe('focus-search')
  expect(globalKey('?', { meta: false, control: false, alt: false }).kind).toBe('system-app')
  // A modifier belongs to the host's own shortcuts, so the engine stands down.
  expect(globalKey('/', { meta: true, control: false, alt: false }).kind).toBe('none')
})

it('names the control each committed preference selects', () => {
  const selected = preferenceSelection({ theme: 'dark', background: 'grid' })

  expect(selected.theme).toBe('projects.theme.dark')
  expect(selected.background).toBe('projects.background.grid')

  // A choice outside the vocabulary selects nothing rather than a bad node.
  expect(preferenceSelection({ theme: 'sepia' }).theme).toBeUndefined()
})

it('carries the preference vocabulary from the engine instead of a copied list', () => {
  const vocabulary = preferenceVocabulary()

  expect(vocabulary.theme?.choices).toEqual(['light', 'dark'])
  expect(vocabulary.theme?.action).toBe('projects.theme')
  expect(vocabulary.background?.choices).toContain('parallax')
})

it('applies a Skin Studio field edit and repaints from the edited binding', () => {
  // Skin Studio addresses a field by `{slot}/{token}`; the painter writes that
  // onto `data-ugui-id`, so this is the id a gesture actually carries back.
  const variables = skinField('winxp', 'palette/surface', '#101010', 'light')

  expect(variables?.['--ugui-palette-surface']).toBe('#101010')
  // The vocabulary alias moves with it, so a painted Document repaints too.
  expect(variables?.['--color-surface']).toBe('#101010')

  // A token outside the style matrix is refused, not silently written.
  expect(skinField('winxp', 'palette/not-a-role', '#000000', 'light')).toBeNull()
  expect(skinField('winxp', 'not-a-slot/surface', '#000000', 'light')).toBeNull()
})

it('PROBE validates the real settings document', async () => {
  const { rawDocumentSource, validateDocument, startEngine } = await import('./catalyst-wasm')
  await startEngine()
  const source = rawDocumentSource('/apps/settings.json')
  console.log('FINDINGS:', JSON.stringify(validateDocument(JSON.parse(source))).slice(0, 400))
})
