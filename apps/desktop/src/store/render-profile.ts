import { atom, computed } from 'nanostores'

import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import {
  applyRenderProfile,
  parseRenderProfileCatalog,
  type RenderProfile,
  type RenderProfileCatalog
} from '@/themes/render-profile'

export const DEFAULT_RENDER_PROFILE = 'glassmorphism'

export const $renderProfileCatalog = atom<RenderProfileCatalog | null>(null)
export const $renderProfileLoading = atom(false)
export const $renderProfileError = atom<string | null>(null)
export const $renderProfileCommittedId = atom(DEFAULT_RENDER_PROFILE)
export const $renderProfilePreviewId = atom<string | null>(null)
export const $renderProfileRevision = atom(0)
export const $renderProfilePending = atom(false)

export const $activeRenderProfile = computed(
  [$renderProfileCatalog, $renderProfileCommittedId, $renderProfilePreviewId],
  (catalog, committedId, previewId) => {
    const id = previewId ?? committedId

    return catalog?.profiles.find(profile => profile.id === id) ?? null
  }
)

let generation = 0
let operationSequence = 0
const profileKey = () => normalizeProfileKey($activeGatewayProfile.get())

const validProfileId = (catalog: RenderProfileCatalog, id: string) =>
  catalog.profiles.some(profile => profile.id === id) ? id : DEFAULT_RENDER_PROFILE

export async function loadRenderProfileCatalog(): Promise<RenderProfileCatalog> {
  const token = ++generation
  const profile = profileKey()
  $renderProfileLoading.set(true)
  $renderProfileError.set(null)

  try {
    const [rawCatalog, preference] = await Promise.all([
      window.hermesDesktop.getUguiSkinCatalog(),
      window.hermesDesktop.renderProfilePreference.get(profile)
    ])

    const catalog = parseRenderProfileCatalog(rawCatalog)

    if (!catalog) {
      throw new Error('ugui-render-profile-catalog-invalid')
    }

    if (
      preference.schema !== 'hermes-render-profile-preference/1' ||
      preference.profile !== profile ||
      !Number.isSafeInteger(preference.revision) ||
      preference.revision < 0
    ) {
      throw new Error('ugui-render-profile-preference-invalid')
    }

    if (token === generation && profile === profileKey()) {
      const committed = validProfileId(catalog, preference.profile_id)
      $renderProfileCatalog.set(catalog)
      $renderProfileRevision.set(preference.revision)
      $renderProfileCommittedId.set(committed)
      $renderProfilePreviewId.set(null)
      applyRenderProfile(catalog.profiles.find(item => item.id === committed)!)
    }

    return catalog
  } catch (error) {
    if (token === generation) {
      $renderProfileError.set(error instanceof Error ? error.message : String(error))
    }

    throw error
  } finally {
    if (token === generation) {
      $renderProfileLoading.set(false)
    }
  }
}

export function previewRenderProfile(id: string): boolean {
  const profile = $renderProfileCatalog.get()?.profiles.find(item => item.id === id)

  if (!profile || $renderProfilePending.get()) {
    return false
  }

  $renderProfilePreviewId.set(id)
  applyRenderProfile(profile)

  return true
}

export async function applyRenderProfilePreview(): Promise<boolean> {
  const id = $renderProfilePreviewId.get()
  const catalog = $renderProfileCatalog.get()
  const selected = id ? catalog?.profiles.find(item => item.id === id) : null
  const committed = catalog?.profiles.find(item => item.id === $renderProfileCommittedId.get())
  const profile = profileKey()
  const expectedRevision = $renderProfileRevision.get()

  if (!id || !selected || !committed || $renderProfilePending.get()) {
    return false
  }

  $renderProfilePending.set(true)
  $renderProfileError.set(null)
  const idempotencyKey = `skin-${profile}-${expectedRevision}-${++operationSequence}`

  try {
    const receipt = await window.hermesDesktop.renderProfilePreference.commit({
      profile,
      profile_id: id,
      expected_revision: expectedRevision,
      idempotency_key: idempotencyKey
    })

    const observed = await window.hermesDesktop.renderProfilePreference.get(profile)

    if (
      receipt.schema !== 'hermes-render-profile-commit/1' ||
      observed.schema !== 'hermes-render-profile-preference/1' ||
      receipt.profile !== profile ||
      observed.profile !== profile ||
      receipt.profile_id !== id ||
      observed.profile_id !== id ||
      receipt.revision !== expectedRevision + 1 ||
      observed.revision !== receipt.revision ||
      !/^sha256:[0-9a-f]{64}$/.test(receipt.receipt_sha256)
    ) {
      throw new Error('ugui-render-profile-readback-invalid')
    }

    $renderProfileRevision.set(observed.revision)
    $renderProfileCommittedId.set(id)
    $renderProfilePreviewId.set(null)
    applyRenderProfile(selected)

    return true
  } catch (error) {
    $renderProfilePreviewId.set(null)
    applyRenderProfile(committed)
    $renderProfileError.set(error instanceof Error ? error.message : String(error))

    return false
  } finally {
    $renderProfilePending.set(false)
  }
}

export function revertRenderProfilePreview(): boolean {
  const profile = $renderProfileCatalog
    .get()
    ?.profiles.find(item => item.id === $renderProfileCommittedId.get())

  $renderProfilePreviewId.set(null)

  if (!profile || $renderProfilePending.get()) {
    return false
  }

  applyRenderProfile(profile)

  return true
}

export async function reconcileRenderProfile(): Promise<RenderProfile | null> {
  await loadRenderProfileCatalog()
  const id = $renderProfileCommittedId.get()

  return $renderProfileCatalog.get()?.profiles.find(item => item.id === id) ?? null
}
