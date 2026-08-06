// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'

import { applyRenderProfile, parseRenderProfileCatalog, type RenderProfile, renderProfileCss } from './render-profile'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { setWasmInputForTests } from '@/app/ae-executive/catalyst-wasm'

// The shell's variables come from the engine, so tests seat it like the app does.
beforeAll(async () => {
  setWasmInputForTests(readFileSync(resolve(process.cwd(), 'public/wasm/catalyst_wasm_bg.wasm')))
  const { startEngine } = await import('@/app/ae-executive/catalyst-wasm')

  await startEngine()
})

const profile = (id: 'glassmorphism' | 'windows-95'): RenderProfile => ({
  schema: 'hermes-render-profile/1',
  authority: 'none',
  id,
  name: id,
  source_sha256: `sha256:${'a'.repeat(64)}`,
  visual_attestation: 'pending',
  named_losses: ['visual attestation pending'],
  axes: {
    palette: {
      surface: id === 'windows-95' ? '#c0c0c0' : 'rgba(17,25,40,0.75)',
      on_surface: id === 'windows-95' ? '#000000' : '#ffffff',
      accent: id === 'windows-95' ? '#000181' : '#60a5fa',
      border: id === 'windows-95' ? '#808080' : 'rgba(255,255,255,0.35)',
      desktop: id === 'windows-95' ? '#008081' : undefined,
      titlebar: id === 'windows-95' ? '#000181' : undefined,
      translucency: id === 'windows-95' ? 0 : 0.75
    },
    typography: {
      family_stack: id === 'windows-95' ? 'Arial, sans-serif' : 'Inter, sans-serif',
      scale_px: id === 'windows-95' ? [11, 13, 16] : [12, 14, 16, 20],
      weights: id === 'windows-95' ? [] : [400, 500, 600],
      casing: 'none',
      tracking: 'normal'
    },
    geometry: {
      radius_px: id === 'windows-95' ? [0] : [12, 16, 20],
      stroke_width_px: id === 'windows-95' ? 2 : 1,
      grid_unit_px: 8
    },
    border: { model: id === 'windows-95' ? 'bevel' : 'outline', raw: {} },
    elevation: {
      blur_px: id === 'windows-95' ? 0 : 24,
      backdrop_blur_px: id === 'windows-95' ? 0 : 20,
      spread_px: 0,
      y_offset_px: id === 'windows-95' ? 0 : 8,
      hardness_px: id === 'windows-95' ? 1 : 0
    },
    density: { spacing_px: id === 'windows-95' ? [4] : [8, 16, 24], control_height_px: id === 'windows-95' ? 23 : undefined },
    motion: { mode: id === 'windows-95' ? 'instant' : 'animated', durations_ms: id === 'windows-95' ? [0] : [150, 250], easing: id === 'windows-95' ? 'linear' : 'ease' },
    chrome: { frame: id === 'windows-95' ? 'beveled' : 'none', titlebar_height_px: id === 'windows-95' ? 18 : undefined, scrollbar_width_px: id === 'windows-95' ? 16 : undefined, raw: {} }
  }
})

describe('render profile admission and projection', () => {
  it('admits a closed catalog but rejects authority, unknown fields, and completed attestation claims', () => {
    const catalog = { schema: 'hermes-render-profile-catalog/1', authority: 'none', profiles: [profile('windows-95')] }
    expect(parseRenderProfileCatalog(catalog)).toEqual(catalog)
    expect(parseRenderProfileCatalog({ ...catalog, authority: 'skin' })).toBeNull()
    expect(parseRenderProfileCatalog({ ...catalog, extra: true })).toBeNull()
    expect(parseRenderProfileCatalog({ ...catalog, profiles: [{ ...profile('windows-95'), visual_attestation: 'passed' }] })).toBeNull()
  })

  it('projects a complete closed variable set and no arbitrary binding strings', () => {
    const windows = renderProfileCss(profile('windows-95'))
    const glass = renderProfileCss(profile('glassmorphism'))

    expect(Object.keys(windows)).toEqual(Object.keys(glass))
    expect(Object.keys(windows)).toHaveLength(129)
    expect(windows['--morph-radius-lg']).toBe('0px')
    expect(windows['--morph-control-height']).toBe('23px')
    expect(windows['--morph-motion-duration']).toBe('0ms')
    expect(glass['--morph-radius-lg']).toBe('20px')
    expect(glass['--morph-backdrop-blur']).toBe('20px')
    // The shell and a painted Document read one projection, so a skin reaches
    // the vocabulary names too rather than only the shell's own.
    expect(windows['--color-surface']).toBe('#c0c0c0')
    expect(windows['--font-sans']).toContain('MS Sans Serif')
    // A role this skin leaves unbound reads as unset, not as the last skin's.
    expect(windows['--color-danger']).toBe('initial')
    expect(JSON.stringify(windows)).not.toContain('javascript:')
  })

  it('changes only render attributes and variables when applied', () => {
    const root = document.createElement('div')
    root.innerHTML = '<button aria-label="Run">Run</button>'
    const before = root.innerHTML

    applyRenderProfile(profile('windows-95'), 'light', root)
    expect(root.dataset).toMatchObject({ uguiSkin: 'windows-95', uguiBorder: 'bevel', uguiChrome: 'beveled', uguiMotion: 'instant' })
    expect(root.style.getPropertyValue('--morph-radius-lg')).toBe('0px')
    expect(root.innerHTML).toBe(before)

    applyRenderProfile(profile('glassmorphism'), 'light', root)
    expect(root.dataset.uguiSkin).toBe('glassmorphism')
    expect(root.innerHTML).toBe(before)
  })
})

it('repaints the same skin against black when the mode is dark', () => {
  const root = document.createElement('div')
  const surfaces = ['--morph-surface', '--morph-desktop', '--morph-on-surface', '--color-surface']

  applyRenderProfile(profile('windows-95'), 'light', root)

  const light = surfaces.map(name => root.style.getPropertyValue(name))

  applyRenderProfile(profile('windows-95'), 'dark', root)

  const dark = surfaces.map(name => root.style.getPropertyValue(name))

  // Every visible shell surface resolves through these, so if they do not move
  // the window stays pinned to the skin's light palette whatever the class says.
  expect(dark).not.toEqual(light)
  expect(root.dataset.uguiMode).toBe('dark')
  // A metric means the same thing in either mode.
  expect(root.style.getPropertyValue('--morph-radius-md')).toBe(
    (() => {
      applyRenderProfile(profile('windows-95'), 'light', root)

      return root.style.getPropertyValue('--morph-radius-md')
    })()
  )
})

it('reads the mode off the element when a caller does not name one', () => {
  const root = document.createElement('div')

  root.classList.add('dark')
  applyRenderProfile(profile('windows-95'), undefined, root)

  // Every store path applies a profile without knowing the mode, so the element
  // it paints onto is the one source of truth.
  expect(root.dataset.uguiMode).toBe('dark')
})
