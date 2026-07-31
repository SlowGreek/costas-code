// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parseRenderProfileCatalog, type RenderProfileCatalog } from '@/themes/render-profile'

import { UguiSkinSettings } from './ugui-skin-settings'

const profiles = ['glassmorphism', 'windows-95'].map(id => ({
  schema: 'hermes-render-profile/1',
  authority: 'none',
  id,
  name: id,
  source_sha256: `sha256:${(id === 'glassmorphism' ? 'a' : 'b').repeat(64)}`,
  visual_attestation: 'pending',
  named_losses: [],
  axes: {
    palette: { surface: '#c0c0c0', on_surface: '#000000', accent: '#000181', border: '#808080', translucency: 0 },
    typography: { family_stack: 'Arial, sans-serif', scale_px: [11], weights: [], casing: 'none', tracking: 'normal' },
    geometry: { radius_px: id === 'windows-95' ? [0] : [16], stroke_width_px: 2, grid_unit_px: 8 },
    border: { model: id === 'windows-95' ? 'bevel' : 'outline', raw: {} },
    elevation: { blur_px: 0, backdrop_blur_px: 0, spread_px: 0, y_offset_px: 0, hardness_px: 1 },
    density: { spacing_px: [4], control_height_px: 23 },
    motion: { mode: 'instant', durations_ms: [0], easing: 'linear' },
    chrome: { frame: id === 'windows-95' ? 'beveled' : 'none', raw: {} }
  }
}))

const catalog = parseRenderProfileCatalog({
  schema: 'hermes-render-profile-catalog/1',
  authority: 'none',
  profiles
}) as RenderProfileCatalog

const document = (committed: string, preview: string) => ({
  schema: 'ae-skin-settings-document/1',
  authority: 'none',
  projector: 'ugui::theme::CATALOG->nested-card->ugui::project_checked',
  document: {
    id: 'skin-settings',
    type: 'document',
    header: [{ id: 'status', type: 'text', body: `Committed ${committed} · Preview ${preview}` }],
    sections: [],
    actions: [
      { id: 'windows', type: 'button', label: 'Windows 95', action: 'skin.preview.windows-95' },
      { id: 'apply', type: 'button', label: 'Apply', action: 'skin.apply' },
      { id: 'revert', type: 'button', label: 'Revert', action: 'skin.revert' }
    ]
  }
})

const get = vi.fn()
const commit = vi.fn()
const getDocument = vi.fn()

beforeEach(() => {
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
  getDocument.mockReset().mockImplementation(async ({ committed_id, preview_id }) => document(committed_id, preview_id))
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: {
      getUguiSkinCatalog: vi.fn(async () => catalog),
      getUguiSkinSettingsDocument: getDocument,
      renderProfilePreference: { get, commit }
    }
  })
})

describe('UGUI cog skin settings', () => {
  it('previews and commits only through semantic Document actions', async () => {
    render(<UguiSkinSettings />)
    const windows = await screen.findByRole('button', { name: 'Windows 95' })
    fireEvent.click(windows)

    await waitFor(() => expect(globalThis.document.documentElement.dataset.uguiSkin).toBe('windows-95'))
    expect(commit).not.toHaveBeenCalled()
    expect(getDocument).toHaveBeenLastCalledWith({ committed_id: 'glassmorphism', preview_id: 'windows-95' })

    get.mockResolvedValueOnce({
      schema: 'hermes-render-profile-preference/1',
      revision: 1,
      profile: 'default',
      profile_id: 'windows-95'
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ profile_id: 'windows-95', expected_revision: 0 }))
  })
})
