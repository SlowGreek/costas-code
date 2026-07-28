import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { discoverAeRepositoryRoot } from './ae-repository-root'
import { loadUguiSkinCatalog, normalizeUguiSkinBinding } from './ugui-skins'

const aeRoot = discoverAeRepositoryRoot({ start: import.meta.dirname })
const bindingsDir = path.join(aeRoot, 'ugui', 'skins', 'bindings')

describe('UGUI generated skin catalog admission', () => {
  it('loads generated canonical profiles with all eight StyleModel axes', () => {
    const catalog = loadUguiSkinCatalog(bindingsDir)
    const windows = catalog.profiles.find(profile => profile.id === 'windows-95')
    const glass = catalog.profiles.find(profile => profile.id === 'glassmorphism')

    expect(catalog.schema).toBe('hermes-ugui-skin-catalog/1')
    expect(catalog.authority).toBe('none')
    expect(windows).toBeTruthy()
    expect(glass).toBeTruthy()

    for (const profile of [windows!, glass!]) {
      expect(Object.keys(profile.binding)).toEqual([
        'palette',
        'typography',
        'geometry',
        'border-model',
        'elevation',
        'density',
        'motion',
        'chrome'
      ])
      expect(profile.provenance.visual_attestation).toBe('pending')
      expect(profile.coverage.all_slots_bound).toBe(true)
      expect(profile.source_sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
  })

  it('normalizes Windows 95 and glass into distinct complete render profiles', () => {
    const catalog = loadUguiSkinCatalog(bindingsDir)
    const windows = normalizeUguiSkinBinding(catalog.profiles.find(profile => profile.id === 'windows-95')!)
    const glass = normalizeUguiSkinBinding(catalog.profiles.find(profile => profile.id === 'glassmorphism')!)

    expect(windows).toMatchObject({
      schema: 'hermes-render-profile/1',
      id: 'windows-95',
      axes: {
        geometry: { radius_px: [0], stroke_width_px: 2, grid_unit_px: 8 },
        border: { model: 'bevel' },
        elevation: { blur_px: 0 },
        density: { spacing_px: [4], control_height_px: 23 },
        motion: { mode: 'instant', durations_ms: [0] },
        chrome: { frame: 'beveled', titlebar_height_px: 18, scrollbar_width_px: 16 }
      }
    })
    expect(glass).toMatchObject({
      schema: 'hermes-render-profile/1',
      id: 'glassmorphism',
      axes: {
        geometry: { radius_px: [12, 16, 20], stroke_width_px: 1, grid_unit_px: 8 },
        border: { model: 'outline' },
        elevation: { blur_px: 24, backdrop_blur_px: 20, y_offset_px: 8 },
        density: { spacing_px: [8, 16, 24, 32, 48] },
        motion: { mode: 'animated', durations_ms: [150, 250, 400] },
        chrome: { frame: 'none' }
      }
    })

    for (const axis of Object.keys(windows.axes) as Array<keyof typeof windows.axes>) {
      expect(windows.axes[axis]).not.toEqual(glass.axes[axis])
    }
  })

  it('normalizes every generated easing set to one bounded CSS value', () => {
    const profiles = loadUguiSkinCatalog(bindingsDir).profiles.map(normalizeUguiSkinBinding)

    for (const profile of profiles) {
      expect(profile.axes.motion.easing, profile.id).not.toMatch(/[;{}]/)
      expect(profile.axes.motion.easing.length, profile.id).toBeLessThanOrEqual(128)
    }

    expect(profiles.find(profile => profile.id === 'carbon')?.axes.motion.easing).toBe(
      'cubic-bezier(0.2,0,0.38,0.9)'
    )
  })

  it('rejects hand-shaped, incomplete, and authority-expanding bindings', () => {
    const catalog = loadUguiSkinCatalog(bindingsDir)
    const source = catalog.profiles.find(profile => profile.id === 'windows-95')!

    expect(() =>
      normalizeUguiSkinBinding({ ...source, _generator: 'react' } as unknown as typeof source)
    ).toThrow('ugui-skin-generator')
    expect(() => normalizeUguiSkinBinding({ ...source, binding: { ...source.binding, chrome: undefined } })).toThrow(
      'ugui-skin-binding'
    )
    expect(() =>
      normalizeUguiSkinBinding({ ...source, authority: 'skin' } as unknown as typeof source)
    ).toThrow('ugui-skin-unknown-field')
  })
})
