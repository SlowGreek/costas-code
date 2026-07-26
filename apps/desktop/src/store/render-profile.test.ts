// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parseRenderProfileCatalog, type RenderProfileCatalog } from '@/themes/render-profile'

import {
  $renderProfileCommittedId,
  $renderProfileError,
  $renderProfilePreviewId,
  $renderProfileRevision,
  applyRenderProfilePreview,
  loadRenderProfileCatalog,
  previewRenderProfile,
  revertRenderProfilePreview
} from './render-profile'

const rawCatalog = {
  schema: 'hermes-render-profile-catalog/1',
  authority: 'none',
  profiles: ['glassmorphism', 'windows-95'].map(id => ({
    schema: 'hermes-render-profile/1',
    authority: 'none',
    id,
    name: id,
    source_sha256: `sha256:${(id === 'glassmorphism' ? 'a' : 'b').repeat(64)}`,
    visual_attestation: 'pending',
    named_losses: [],
    axes: {
      palette: { surface: '#c0c0c0', on_surface: '#000000', accent: '#000181', border: '#808080', translucency: 0 },
      typography: { family_stack: 'Arial, sans-serif', scale_px: [11, 13], weights: [], casing: 'none', tracking: 'normal' },
      geometry: { radius_px: id === 'windows-95' ? [0] : [16], stroke_width_px: 2, grid_unit_px: 8 },
      border: { model: id === 'windows-95' ? 'bevel' : 'outline', raw: {} },
      elevation: { blur_px: 0, backdrop_blur_px: 0, spread_px: 0, y_offset_px: 0, hardness_px: 1 },
      density: { spacing_px: [4], control_height_px: 23 },
      motion: { mode: 'instant', durations_ms: [0], easing: 'linear' },
      chrome: { frame: id === 'windows-95' ? 'beveled' : 'none', raw: {} }
    }
  }))
}

const get = vi.fn()
const commit = vi.fn()

beforeEach(() => {
  const catalog = parseRenderProfileCatalog(rawCatalog) as RenderProfileCatalog
  get.mockReset().mockResolvedValue({
    schema: 'hermes-render-profile-preference/1',
    revision: 0,
    profile: 'default',
    profile_id: 'glassmorphism'
  })
  commit.mockReset().mockResolvedValue({
    schema: 'hermes-render-profile-commit/1',
    revision: 1,
    profile: 'default',
    profile_id: 'windows-95',
    receipt_sha256: `sha256:${'c'.repeat(64)}`,
    idempotent: false
  })
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      getUguiSkinCatalog: vi.fn(async () => catalog),
      renderProfilePreference: { get, commit }
    }
  })
})

describe('profile-scoped UGUI render profile lifecycle', () => {
  it('previews ephemerally, commits through Electron, reads back, and reverts', async () => {
    await loadRenderProfileCatalog()
    expect($renderProfileCommittedId.get()).toBe('glassmorphism')

    expect(previewRenderProfile('windows-95')).toBe(true)
    expect($renderProfilePreviewId.get()).toBe('windows-95')
    expect(document.documentElement.dataset.uguiSkin).toBe('windows-95')
    expect(commit).not.toHaveBeenCalled()

    expect(revertRenderProfilePreview()).toBe(true)
    expect(document.documentElement.dataset.uguiSkin).toBe('glassmorphism')

    expect(previewRenderProfile('windows-95')).toBe(true)
    get.mockResolvedValueOnce({
      schema: 'hermes-render-profile-preference/1',
      revision: 1,
      profile: 'default',
      profile_id: 'windows-95'
    })
    expect(await applyRenderProfilePreview()).toBe(true)
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'default', profile_id: 'windows-95', expected_revision: 0 })
    )
    expect($renderProfileRevision.get()).toBe(1)
    expect($renderProfileCommittedId.get()).toBe('windows-95')
    expect($renderProfilePreviewId.get()).toBeNull()
  })

  it('rolls back visibly when authoritative commit fails', async () => {
    await loadRenderProfileCatalog()
    expect(previewRenderProfile('windows-95')).toBe(true)
    commit.mockRejectedValueOnce(new Error('render-profile-revision-conflict'))

    expect(await applyRenderProfilePreview()).toBe(false)
    expect($renderProfilePreviewId.get()).toBeNull()
    expect($renderProfileCommittedId.get()).toBe('glassmorphism')
    expect(document.documentElement.dataset.uguiSkin).toBe('glassmorphism')
    expect($renderProfileError.get()).toContain('revision-conflict')
  })

  it('refuses unknown profile ids', async () => {
    await loadRenderProfileCatalog()
    expect(previewRenderProfile('../escape')).toBe(false)
    expect($renderProfilePreviewId.get()).toBeNull()
  })
})
