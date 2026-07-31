import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildShellViewportModel, composeShellViewportDocument } from './shell-viewport'

const aeRoot = path.resolve(import.meta.dirname, '../../../..')

const source = () => ({
  builds: JSON.parse(fs.readFileSync(path.join(aeRoot, 'run/SHELL-BUILDS.json'), 'utf8')),
  capabilities: JSON.parse(
    fs.readFileSync(path.join(aeRoot, 'envelope/capabilities/generated/SHELL-CAPABILITY-PARITY.json'), 'utf8')
  ),
  surfaces: JSON.parse(fs.readFileSync(path.join(aeRoot, 'ugui/json/surface-profiles.json'), 'utf8'))
})

describe('UGUI SHELL viewport model', () => {
  it('keeps shell, surface geometry, and target as independent axes', () => {
    const model = buildShellViewportModel(source(), {
      shell_id: 'android-shell',
      surface_profile_id: 'google-pixel-9',
      target_id: 'android-arm64-v8a'
    })

    expect(model).toMatchObject({
      schema: 'ae-shell-viewport-model/1',
      authority: 'none',
      shell: { id: 'android-shell', platform: 'android' },
      surface: {
        id: 'google-pixel-9',
        form_factor: 'handset',
        geometry: { mode: 'fixed', viewport: { width: 360, height: 808, unit: 'dp' } }
      },
      target: {
        id: 'android-arm64-v8a',
        architecture: 'aarch64',
        package: 'apk',
        rungs: {
          source: 'declared',
          artifact: 'missing',
          package_install: 'missing',
          physical_runtime: 'missing'
        }
      },
      posture: 'structural-projection',
      capability_summary: { available: 0, degraded: 2, unavailable: 0, unknown: 151 }
    })
    expect(model.warning).toContain('NOT A PHYSICAL RUN')
  })

  it('distinguishes device and simulator targets without promotion', () => {
    const vision = buildShellViewportModel(source(), {
      shell_id: 'macos-shell',
      surface_profile_id: 'visionos-spatial',
      target_id: 'visionos-arm64-simulator'
    })

    expect(vision.surface.form_factor).toBe('spatial')
    expect(vision.target.sdk).toBe('xrsimulator')
    expect(vision.target.rungs.physical_runtime).toBe('missing')
    expect(vision.posture).toBe('structural-projection')
  })

  it('fails closed on incompatible or unsafe axis combinations', () => {
    expect(() =>
      buildShellViewportModel(source(), {
        shell_id: 'android-shell',
        surface_profile_id: 'iphone-14-pro',
        target_id: 'android-arm64-v8a'
      })
    ).toThrow('shell-surface-incompatible')
    expect(() =>
      buildShellViewportModel(source(), {
        shell_id: '../escape',
        surface_profile_id: 'google-pixel-9',
        target_id: 'android-arm64-v8a'
      })
    ).toThrow('shell-viewport-id')
  })

  it('keeps the semantic demo invariant across compatible shell projections', () => {
    const sources = source()

    const android = composeShellViewportDocument(
      buildShellViewportModel(sources, {
        shell_id: 'android-shell',
        surface_profile_id: 'google-pixel-9',
        target_id: 'android-arm64-v8a'
      })
    )

    const macos = composeShellViewportDocument(
      buildShellViewportModel(sources, {
        shell_id: 'macos-shell',
        surface_profile_id: 'macos-desktop',
        target_id: 'macos-arm64'
      })
    )

    const semantic = (document: typeof android) =>
      document.actions.filter(action =>
        typeof action === 'object' && !Array.isArray(action) && action.id === 'viewport-demo-action'
      )

    expect(semantic(android)).toEqual(semantic(macos))
    expect((android.sections[0] as Record<string, unknown>).model).not.toEqual(
      (macos.sections[0] as Record<string, unknown>).model
    )
  })

  it('composes a canonical Document with read-only selection actions and no authority verbs', () => {
    const model = buildShellViewportModel(source(), {
      shell_id: 'android-shell',
      surface_profile_id: 'google-pixel-9',
      target_id: 'android-arm64-v8a'
    })

    const document = composeShellViewportDocument(model)
    const actions = document.actions
      .map(item => typeof item === 'object' && item && !Array.isArray(item) ? item.action : null)
      .filter((action): action is string => typeof action === 'string')

    expect(actions).toContain('shell.target.android-shell')
    expect(actions).toContain('shell.surface.google-pixel-9')
    expect(actions).toContain('shell.build.android-arm64-v8a')
    expect(actions.some(action => /^(?:host|effect)\.(?:launch|build|install|exec|dispatch)/.test(action))).toBe(false)
    expect(document).not.toHaveProperty('sceneVersion')
    expect(document).not.toHaveProperty('root')
    expect(document).not.toHaveProperty('nodes')
    expect(JSON.stringify(document)).toContain('STRUCTURAL PROJECTION — NOT A PHYSICAL RUN')
  })
})
