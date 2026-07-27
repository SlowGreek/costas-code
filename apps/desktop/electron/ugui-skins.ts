import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const GENERATOR = 'ugui-codegen/skin-bindings/1'

const SLOT_ORDER = [
  'palette',
  'typography',
  'geometry',
  'border-model',
  'elevation',
  'density',
  'motion',
  'chrome'
] as const

const TOP_LEVEL_KEYS = new Set([
  '_banner',
  '_generator',
  '_source_hashes',
  'artifact_role',
  'id',
  'name',
  'binding',
  'provenance',
  'coverage',
  'source_sha256'
])

const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/
const SHA_RE = /^[0-9a-f]{64}$/
const MAX_PROFILES = 64
const MAX_SOURCE_BYTES = 128 * 1024

type SlotName = (typeof SLOT_ORDER)[number]
type Binding = Record<SlotName, Record<string, string>>

export interface UguiSkinBinding {
  _banner: string
  _generator: typeof GENERATOR
  _source_hashes: Record<string, string>
  artifact_role?: string
  id: string
  name: string
  binding: Binding
  provenance: {
    visual_attestation: 'pending'
    known_losses: string[]
    fidelity_boundary: string
    [key: string]: unknown
  }
  coverage: {
    all_slots_bound: true
    bound_token_count: number
    required_token_count: number
    required_tokens_bound: number
  }
  source_sha256: `sha256:${string}`
}

export interface HermesRenderProfile {
  schema: 'hermes-render-profile/1'
  authority: 'none'
  id: string
  name: string
  source_sha256: `sha256:${string}`
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
    typography: {
      family_stack: string
      scale_px: number[]
      weights: number[]
      casing: string
      tracking: string
    }
    geometry: { radius_px: number[]; stroke_width_px: number; grid_unit_px: number }
    border: { model: 'bevel' | 'box-drawing' | 'flat' | 'outline' | 'underline'; raw: Record<string, string> }
    elevation: {
      blur_px: number
      backdrop_blur_px: number
      spread_px: number
      y_offset_px: number
      hardness_px: number
    }
    density: { spacing_px: number[]; control_height_px?: number; hit_target_px?: number }
    motion: { mode: 'animated' | 'instant'; durations_ms: number[]; easing: string }
    chrome: {
      frame: 'beveled' | 'none' | 'standard'
      titlebar_height_px?: number
      scrollbar_width_px?: number
      raw: Record<string, string>
    }
  }
}

export interface UguiSkinCatalog {
  schema: 'hermes-ugui-skin-catalog/1'
  authority: 'none'
  profiles: UguiSkinBinding[]
}

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, error: string): void {
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error(error)
  }
}

function sha256(bytes: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function finiteNonnegative(value: unknown, error: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(error)
  }

  return value
}

function validateBinding(value: unknown): Binding {
  if (!object(value) || Object.keys(value).length !== SLOT_ORDER.length) {
    throw new Error('ugui-skin-binding')
  }

  const result = {} as Binding

  for (const slot of SLOT_ORDER) {
    const raw = value[slot]

    if (!object(raw) || Object.keys(raw).length > 32) {
      throw new Error('ugui-skin-binding')
    }

    const entries: Record<string, string> = {}

    for (const [token, tokenValue] of Object.entries(raw)) {
      if (
        !/^[a-z][a-z0-9-]{0,63}$/.test(token) ||
        typeof tokenValue !== 'string' ||
        tokenValue.length > 512 ||
        /(?:url\s*\(|javascript:|<script|@import|expression\s*\()/i.test(tokenValue)
      ) {
        throw new Error('ugui-skin-token')
      }

      entries[token] = tokenValue
    }

    result[slot] = entries
  }

  return result
}

function parseBindingDocument(value: unknown, sourceSha256: `sha256:${string}`): UguiSkinBinding {
  if (!object(value)) {
    throw new Error('ugui-skin-document')
  }

  exactKeys(value, TOP_LEVEL_KEYS, 'ugui-skin-unknown-field')

  if (value._generator !== GENERATOR) {
    throw new Error('ugui-skin-generator')
  }

  if (
    typeof value._banner !== 'string' ||
    typeof value.id !== 'string' ||
    !SAFE_ID_RE.test(value.id) ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.length > 128 ||
    !object(value._source_hashes) ||
    !object(value.provenance) ||
    !object(value.coverage)
  ) {
    throw new Error('ugui-skin-document')
  }

  if (
    Object.values(value._source_hashes).some(hash => typeof hash !== 'string' || !SHA_RE.test(hash)) ||
    value.provenance.visual_attestation !== 'pending' ||
    !Array.isArray(value.provenance.known_losses) ||
    value.provenance.known_losses.length > 32 ||
    value.provenance.known_losses.some(loss => typeof loss !== 'string' || loss.length > 1024) ||
    typeof value.provenance.fidelity_boundary !== 'string' ||
    value.coverage.all_slots_bound !== true ||
    finiteNonnegative(value.coverage.bound_token_count, 'ugui-skin-coverage') < 1 ||
    finiteNonnegative(value.coverage.required_token_count, 'ugui-skin-coverage') < 1 ||
    finiteNonnegative(value.coverage.required_tokens_bound, 'ugui-skin-coverage') < 1
  ) {
    throw new Error('ugui-skin-provenance')
  }

  return {
    ...(value as unknown as Omit<UguiSkinBinding, 'binding' | 'source_sha256'>),
    binding: validateBinding(value.binding),
    source_sha256: sourceSha256
  }
}

export function loadUguiSkinCatalog(directory: string): UguiSkinCatalog {
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name))

  if (entries.length < 1 || entries.length > MAX_PROFILES) {
    throw new Error('ugui-skin-catalog-bound')
  }

  const profiles = entries.map(entry => {
    const file = path.join(directory, entry.name)
    const bytes = fs.readFileSync(file)

    if (bytes.length < 2 || bytes.length > MAX_SOURCE_BYTES) {
      throw new Error('ugui-skin-source-bound')
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new Error('ugui-skin-json')
    }

    return parseBindingDocument(parsed, sha256(bytes))
  })

  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) {
    throw new Error('ugui-skin-duplicate')
  }

  return { schema: 'hermes-ugui-skin-catalog/1', authority: 'none', profiles }
}

const firstNumber = (value: string | undefined, fallback = 0): number => {
  const match = value?.match(/-?\d+(?:\.\d+)?/)
  const number = match ? Number(match[0]) : fallback

  return Number.isFinite(number) ? number : fallback
}

const numberList = (value: string | undefined): number[] =>
  value ? [...value.matchAll(/-?\d+(?:\.\d+)?/g)].map(match => Number(match[0])).filter(Number.isFinite) : []

const normalizedEasing = (value: string | undefined): string => {
  const first = (value ?? 'linear').split(';', 1)[0].trim()
  const candidate = first.includes(':') ? first.slice(first.indexOf(':') + 1).trim() : first

  return candidate.length <= 128 &&
    /^(?:linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\([-0-9., ]+\)|steps\([0-9A-Za-z, -]+\))$/.test(candidate)
    ? candidate
    : 'linear'
}

function borderModel(binding: Binding['border-model']): HermesRenderProfile['axes']['border']['model'] {
  if (binding.bevel || binding['raised-delta'] || binding['sunken-delta']) {return 'bevel'}

  if (binding['box-drawing']) {return 'box-drawing'}

  if (binding.underline) {return 'underline'}

  if (binding.outline || binding['reveal-highlight']) {return 'outline'}

  return 'flat'
}

function frameModel(value: string | undefined): HermesRenderProfile['axes']['chrome']['frame'] {
  if (!value || value === 'none') {return 'none'}

  return /bevel|raised|sunken/i.test(value) ? 'beveled' : 'standard'
}

export function normalizeUguiSkinBinding(value: UguiSkinBinding): HermesRenderProfile {
  const source = parseBindingDocument(value, value.source_sha256)
  const b = source.binding
  const durations = numberList(b.motion['duration-ramp'] ?? b.motion.none)

  return {
    schema: 'hermes-render-profile/1',
    authority: 'none',
    id: source.id,
    name: source.name,
    source_sha256: source.source_sha256,
    visual_attestation: 'pending',
    named_losses: [...source.provenance.known_losses],
    axes: {
      palette: {
        surface: b.palette.surface ?? '#000000',
        on_surface: b.palette['on-surface'] ?? '#ffffff',
        accent: b.palette.accent ?? b.palette.primary ?? '#000000',
        border: b.palette.border ?? 'transparent',
        desktop: b.palette.desktop,
        titlebar: b.palette.titlebar,
        translucency: Math.min(1, Math.max(0, firstNumber(b.palette.translucency)))
      },
      typography: {
        family_stack: b.typography['family-stack'] ?? 'system-ui, sans-serif',
        scale_px: numberList(b.typography['scale-ramp']),
        weights: numberList(b.typography['weight-set']),
        casing: b.typography.case ?? 'none',
        tracking: b.typography.tracking ?? 'normal'
      },
      geometry: {
        radius_px: numberList(b.geometry['radius-scale']),
        stroke_width_px: Math.max(0, firstNumber(b.geometry['stroke-width'], 1)),
        grid_unit_px: Math.max(1, firstNumber(b.geometry['grid-unit'], 4))
      },
      border: { model: borderModel(b['border-model']), raw: { ...b['border-model'] } },
      elevation: {
        blur_px: Math.max(0, firstNumber(b.elevation.blur)),
        backdrop_blur_px: Math.max(0, firstNumber(b.elevation['backdrop-blur'])),
        spread_px: firstNumber(b.elevation.spread),
        y_offset_px: firstNumber(b.elevation['y-offset']),
        hardness_px: Math.max(0, firstNumber(b.elevation.hardness))
      },
      density: {
        spacing_px: numberList(b.density['spacing-scale']),
        control_height_px: b.density['control-height']
          ? Math.max(1, firstNumber(b.density['control-height']))
          : undefined,
        hit_target_px: b.density['hit-target'] ? Math.max(1, firstNumber(b.density['hit-target'])) : undefined
      },
      motion: {
        mode: b.motion.none !== undefined ? 'instant' : 'animated',
        durations_ms: durations.length ? durations : [0],
        easing: normalizedEasing(b.motion['easing-set'])
      },
      chrome: {
        frame: frameModel(b.chrome['window-frame']),
        titlebar_height_px: b.chrome['title-bar'] ? firstNumber(b.chrome['title-bar']) : undefined,
        scrollbar_width_px: b.chrome.scrollbar ? firstNumber(b.chrome.scrollbar) : undefined,
        raw: { ...b.chrome }
      }
    }
  }
}
