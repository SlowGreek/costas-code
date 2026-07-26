export const RENDER_PROFILE_SCHEMA = 'hermes-render-profile/1' as const

export interface RenderProfile {
  schema: typeof RENDER_PROFILE_SCHEMA
  authority: 'none'
  id: string
  name: string
  source_sha256: string
  visual_attestation: 'pending'
  named_losses: string[]
  axes: {
    palette: {
      surface: string
      on_surface: string
      accent: string
      border: string
      desktop?: string
      titlebar?: string
      translucency: number
    }
    typography: { family_stack: string; scale_px: number[]; weights: number[]; casing: string; tracking: string }
    geometry: { radius_px: number[]; stroke_width_px: number; grid_unit_px: number }
    border: { model: 'bevel' | 'box-drawing' | 'flat' | 'outline' | 'underline'; raw: Record<string, string> }
    elevation: { blur_px: number; backdrop_blur_px: number; spread_px: number; y_offset_px: number; hardness_px: number }
    density: { spacing_px: number[]; control_height_px?: number; hit_target_px?: number }
    motion: { mode: 'animated' | 'instant'; durations_ms: number[]; easing: string }
    chrome: { frame: 'beveled' | 'none' | 'standard'; titlebar_height_px?: number; scrollbar_width_px?: number; raw: Record<string, string> }
  }
}

export interface RenderProfileCatalog {
  schema: 'hermes-render-profile-catalog/1'
  authority: 'none'
  profiles: RenderProfile[]
}

const HASH_RE = /^sha256:[0-9a-f]{64}$/
const ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/
const COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|rgba?\([^)]{1,96}\)|transparent)$/
const AXES = ['palette', 'typography', 'geometry', 'border', 'elevation', 'density', 'motion', 'chrome'] as const

const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  const expected = new Set(keys)

  return Object.keys(value).length === keys.length && Object.keys(value).every(key => expected.has(key))
}

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

const finiteList = (value: unknown, maxItems: number, min: number, max: number) =>
  Array.isArray(value) && value.length <= maxItems && value.every(item => finite(item, min, max))

const optionalFinite = (value: unknown, min: number, max: number) => value === undefined || finite(value, min, max)

const rawMap = (value: unknown) =>
  object(value) &&
  Object.keys(value).length <= 32 &&
  Object.entries(value).every(
    ([key, item]) => /^[a-z][a-z0-9-]{0,63}$/.test(key) && typeof item === 'string' && item.length <= 512
  )

export function parseRenderProfileCatalog(value: unknown): RenderProfileCatalog | null {
  if (!object(value) || !exact(value, ['schema', 'authority', 'profiles'])) {return null}

  if (value.schema !== 'hermes-render-profile-catalog/1' || value.authority !== 'none' || !Array.isArray(value.profiles)) {return null}

  if (value.profiles.length < 1 || value.profiles.length > 64) {return null}

  const profiles = value.profiles.map(parseRenderProfile)

  if (profiles.some(profile => !profile)) {return null}
  const admitted = profiles as RenderProfile[]

  if (new Set(admitted.map(profile => profile.id)).size !== admitted.length) {return null}

  return { schema: 'hermes-render-profile-catalog/1', authority: 'none', profiles: admitted }
}

export function parseRenderProfile(value: unknown): RenderProfile | null {
  if (!object(value) || !exact(value, ['schema', 'authority', 'id', 'name', 'source_sha256', 'visual_attestation', 'named_losses', 'axes'])) {return null}

  if (
    value.schema !== RENDER_PROFILE_SCHEMA ||
    value.authority !== 'none' ||
    typeof value.id !== 'string' ||
    !ID_RE.test(value.id) ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.length > 128 ||
    typeof value.source_sha256 !== 'string' ||
    !HASH_RE.test(value.source_sha256) ||
    value.visual_attestation !== 'pending' ||
    !Array.isArray(value.named_losses) ||
    value.named_losses.length > 32 ||
    value.named_losses.some(loss => typeof loss !== 'string' || loss.length > 1024) ||
    !object(value.axes) ||
    !exact(value.axes, AXES)
  ) {return null}

  const axes = value.axes
  const palette = axes.palette
  const typography = axes.typography
  const geometry = axes.geometry
  const border = axes.border
  const elevation = axes.elevation
  const density = axes.density
  const motion = axes.motion
  const chrome = axes.chrome

  if (!object(palette)) {return null}

  if (!object(typography)) {return null}

  if (!object(geometry)) {return null}

  if (!object(border)) {return null}

  if (!object(elevation)) {return null}

  if (!object(density)) {return null}

  if (!object(motion)) {return null}

  if (!object(chrome)) {return null}

  if (
    !exact(palette, ['surface', 'on_surface', 'accent', 'border', 'desktop', 'titlebar', 'translucency'].filter(key => key in palette)) ||
    !['surface', 'on_surface', 'accent', 'border'].every(key => typeof palette[key] === 'string' && COLOR_RE.test(String(palette[key]))) ||
    !['desktop', 'titlebar'].every(key => palette[key] === undefined || (typeof palette[key] === 'string' && COLOR_RE.test(String(palette[key])))) ||
    !finite(palette.translucency, 0, 1)
  ) {return null}

  if (
    !exact(typography, ['family_stack', 'scale_px', 'weights', 'casing', 'tracking']) ||
    typeof typography.family_stack !== 'string' || typography.family_stack.length > 512 || /url\s*\(|javascript:/i.test(typography.family_stack) ||
    !finiteList(typography.scale_px, 16, 0, 128) || !finiteList(typography.weights, 16, 1, 1000) ||
    typeof typography.casing !== 'string' || typography.casing.length > 64 || typeof typography.tracking !== 'string' || typography.tracking.length > 128
  ) {return null}

  if (!exact(geometry, ['radius_px', 'stroke_width_px', 'grid_unit_px']) || !finiteList(geometry.radius_px, 8, 0, 128) || !finite(geometry.stroke_width_px, 0, 16) || !finite(geometry.grid_unit_px, 1, 64)) {return null}

  if (!exact(border, ['model', 'raw']) || !['bevel', 'box-drawing', 'flat', 'outline', 'underline'].includes(String(border.model)) || !rawMap(border.raw)) {return null}

  if (!exact(elevation, ['blur_px', 'backdrop_blur_px', 'spread_px', 'y_offset_px', 'hardness_px']) || !['blur_px', 'backdrop_blur_px', 'hardness_px'].every(key => finite(elevation[key], 0, 128)) || !['spread_px', 'y_offset_px'].every(key => finite(elevation[key], -128, 128))) {return null}

  if (!exact(density, ['spacing_px', 'control_height_px', 'hit_target_px'].filter(key => key in density)) || !finiteList(density.spacing_px, 16, 0, 128) || !optionalFinite(density.control_height_px, 1, 128) || !optionalFinite(density.hit_target_px, 1, 128)) {return null}

  if (!exact(motion, ['mode', 'durations_ms', 'easing']) || !['animated', 'instant'].includes(String(motion.mode)) || !finiteList(motion.durations_ms, 8, 0, 10_000) || typeof motion.easing !== 'string' || motion.easing.length > 128 || /[;{}]/.test(motion.easing)) {return null}

  if (!exact(chrome, ['frame', 'titlebar_height_px', 'scrollbar_width_px', 'raw'].filter(key => key in chrome)) || !['beveled', 'none', 'standard'].includes(String(chrome.frame)) || !optionalFinite(chrome.titlebar_height_px, 0, 128) || !optionalFinite(chrome.scrollbar_width_px, 0, 64) || !rawMap(chrome.raw)) {return null}

  return value as unknown as RenderProfile
}

const px = (value: number) => `${value}px`

export function renderProfileCss(profile: RenderProfile): Record<string, string> {
  const a = profile.axes
  const radii = a.geometry.radius_px.length ? a.geometry.radius_px : [0]
  const spacing = a.density.spacing_px.length ? a.density.spacing_px : [a.geometry.grid_unit_px]
  const duration = a.motion.mode === 'instant' ? 0 : (a.motion.durations_ms[0] ?? 0)

  const shadow =
    a.border.model === 'bevel'
      ? 'inset 2px 2px 0 #ffffff, inset -2px -2px 0 #808080'
      : `${px(0)} ${px(a.elevation.y_offset_px)} ${px(a.elevation.blur_px)} ${px(a.elevation.spread_px)} color-mix(in srgb, #000 22%, transparent)`

  return {
    '--morph-surface': a.palette.surface,
    '--morph-on-surface': a.palette.on_surface,
    '--morph-accent': a.palette.accent,
    '--morph-border-color': a.palette.border,
    '--morph-desktop': a.palette.desktop ?? a.palette.surface,
    '--morph-titlebar': a.palette.titlebar ?? a.palette.surface,
    '--morph-translucency': String(a.palette.translucency),
    '--morph-font-family': a.typography.family_stack,
    '--morph-radius-sm': px(radii[0] ?? 0),
    '--morph-radius-md': px(radii[Math.min(1, radii.length - 1)] ?? 0),
    '--morph-radius-lg': px(radii[radii.length - 1] ?? 0),
    '--morph-stroke-width': px(a.geometry.stroke_width_px),
    '--morph-grid-unit': px(a.geometry.grid_unit_px),
    '--morph-spacing': px(spacing[0] ?? a.geometry.grid_unit_px),
    '--morph-control-height': px(a.density.control_height_px ?? 32),
    '--morph-hit-target': px(a.density.hit_target_px ?? a.density.control_height_px ?? 32),
    '--morph-shadow': shadow,
    '--morph-backdrop-blur': px(a.elevation.backdrop_blur_px),
    '--morph-motion-duration': `${duration}ms`,
    '--morph-motion-easing': a.motion.mode === 'instant' ? 'step-end' : a.motion.easing,
    '--morph-scrollbar-width': px(a.chrome.scrollbar_width_px ?? 8),
    '--morph-titlebar-height': px(a.chrome.titlebar_height_px ?? 28)
  }
}

export function applyRenderProfile(profile: RenderProfile, root: HTMLElement = document.documentElement): void {
  root.dataset.uguiSkin = profile.id
  root.dataset.uguiBorder = profile.axes.border.model
  root.dataset.uguiChrome = profile.axes.chrome.frame
  root.dataset.uguiMotion = profile.axes.motion.mode

  for (const [name, value] of Object.entries(renderProfileCss(profile))) {root.style.setProperty(name, value)}

  const background = opaqueNativeColor(profile.axes.palette.surface, profile.axes.palette.desktop ?? '#101010')
  const foreground = opaqueNativeColor(profile.axes.palette.on_surface, '#ffffff')

  if (background && foreground) {window.hermesDesktop?.setTitleBarTheme?.({ background, foreground })}
}

function opaqueNativeColor(value: string, fallback: string): string | null {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {return value}

  const rgba = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/)

  if (!rgba) {return /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback : null}

  const alpha = rgba[4] === undefined ? 1 : Number(rgba[4])
  const base = fallback.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/)

  if (!base || !Number.isFinite(alpha)) {return null}

  const channels = [1, 2, 3].map(index => {
    const source = Math.min(255, Number(rgba[index]))
    const under = Number.parseInt(base[index], 16)

    return Math.round(source * alpha + under * (1 - alpha)).toString(16).padStart(2, '0')
  })

  return `#${channels.join('')}`
}
