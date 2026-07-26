import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SAFE_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

const PLATFORM_BY_SHELL: Record<string, string[]> = {
  'android-shell': ['android'],
  'linux-shell': ['linux'],
  'macos-shell': ['macos', 'ios'],
  'windows-shell': ['windows']
}

export interface ShellViewportSource {
  builds: Record<string, unknown>
  capabilities: Record<string, unknown>
  surfaces: Record<string, unknown>
}

export interface ShellViewportRequest {
  shell_id: string
  surface_profile_id: string
  target_id: string
}

export interface ShellViewportModel {
  schema: 'ae-shell-viewport-model/1'
  authority: 'none'
  source_hashes: {
    builds: `sha256:${string}`
    capabilities: `sha256:${string}`
    surfaces: `sha256:${string}`
  }
  shell: {
    id: string
    owner: string
    platform: string
    manifest: string
  }
  surface: {
    id: string
    name: string
    form_factor: 'desktop' | 'handset' | 'spatial' | 'wearable'
    production_hosts: string[]
    geometry: Record<string, unknown>
    safe_area: Record<string, unknown>
    corner_radii: Record<string, unknown>
    chrome: string[]
    window_policy: string
    sources: Array<Record<string, unknown>>
  }
  target: {
    id: string
    cell_id: string
    architecture: string
    sdk: string
    abi: null | string
    package: string
    artifact_kind: string
    disposition: string
    owner_ref: string
    reason: string
    rungs: {
      source: string
      artifact: string
      package_install: string
      physical_runtime: string
    }
  }
  capability_summary: Record<'available' | 'degraded' | 'unavailable' | 'unknown', number>
  capability_sample: Array<{
    id: string
    availability: 'available' | 'degraded' | 'unavailable' | 'unknown'
    owner: string
    reason: string
  }>
  posture: 'structural-projection'
  warning: string
  selector: {
    shells: string[]
    surfaces: string[]
    targets: string[]
  }
}

export interface SceneNode {
  id: string
  p: string
  a?: Record<string, unknown>
  on?: Record<string, string>
  kids?: string[]
  layout?: Record<string, unknown>
}

export interface ShellViewportScene {
  sceneVersion: '1.0.0'
  id: string
  root: string
  nodes: SceneNode[]
  receipt: Record<string, unknown>
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const string = (value: unknown): string => (typeof value === 'string' ? value : '')

const hash = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

export function loadShellViewportSource(directory: string): ShellViewportSource {
  const read = (name: string): Record<string, unknown> => {
    const file = path.join(directory, name)
    const bytes = fs.readFileSync(file)

    if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) {throw new Error('shell-viewport-source-bound')}
    const value: unknown = JSON.parse(bytes.toString('utf8'))

    if (!object(value)) {throw new Error('shell-viewport-source-invalid')}

    return value
  }

  return {
    builds: read('shell-builds.json'),
    capabilities: read('shell-capability-parity.json'),
    surfaces: read('surface-profiles.json')
  }
}

function safeRequest(request: ShellViewportRequest): void {
  if (![request.shell_id, request.surface_profile_id, request.target_id].every(value => SAFE_ID_RE.test(value))) {
    throw new Error('shell-viewport-id')
  }
}

function platformForCapability(buildPlatform: string): string {
  if (buildPlatform === 'linux-desktop') {return 'linux'}

  if (buildPlatform === 'windows-desktop') {return 'windows'}

  if (['visionos', 'tvos', 'watchos'].includes(buildPlatform)) {return 'ios'}

  return buildPlatform
}

function compatible(shellId: string, buildPlatform: string, productionHosts: string[]): boolean {
  const capabilityPlatform = platformForCapability(buildPlatform)

  if (!(PLATFORM_BY_SHELL[shellId] ?? []).includes(capabilityPlatform)) {return false}

  if (shellId === 'android-shell') {return productionHosts.includes('android-shell')}

  if (shellId === 'macos-shell') {return productionHosts.some(host => host.startsWith('macos') || host.startsWith('ios') || host.startsWith('apple-'))}

  return true
}

export function buildShellViewportModel(source: ShellViewportSource, request: ShellViewportRequest): ShellViewportModel {
  safeRequest(request)
  const builds = source.builds
  const capabilities = source.capabilities
  const surfaces = source.surfaces

  if (
    builds.schema !== 'ae-shell-build-matrix/1' ||
    capabilities.schema !== 'ae-shell-capability-parity/1.0.0' ||
    surfaces.schema !== 'ugui-surface-profiles/v1'
  ) {throw new Error('shell-viewport-source-schema')}

  const shell = array(builds.shells).find(row => object(row) && row.id === request.shell_id)
  const surface = array(surfaces.profiles).find(row => object(row) && row.id === request.surface_profile_id)

  const target = array(builds.platforms)
    .filter(object)
    .flatMap(platform => array(platform.targets).filter(object).map(row => ({ platform, row })))
    .find(entry => entry.row.id === request.target_id)

  const cell = array(builds.cells).find(row => object(row) && row.shell === request.shell_id && row.target === request.target_id)

  if (!object(shell) || !object(surface) || !target || !object(cell)) {throw new Error('shell-viewport-selection')}

  const buildPlatform = string(target.platform.id)
  const productionHosts = array(surface.productionHosts).map(string).filter(Boolean)

  if (!compatible(request.shell_id, buildPlatform, productionHosts)) {throw new Error('shell-surface-incompatible')}

  const capabilityPlatform = platformForCapability(buildPlatform)

  const capabilityRows = array(capabilities.capabilities)
    .filter(object)
    .map(row => ({ row, platform: object(row.platforms) && object(row.platforms[capabilityPlatform]) ? row.platforms[capabilityPlatform] as Record<string, unknown> : null }))
    .filter((entry): entry is { row: Record<string, unknown>; platform: Record<string, unknown> } => Boolean(entry.platform))

  const counts: ShellViewportModel['capability_summary'] = { available: 0, degraded: 0, unavailable: 0, unknown: 0 }

  for (const entry of capabilityRows) {
    const availability = string(entry.platform.availability) as keyof typeof counts

    if (!(availability in counts)) {throw new Error('shell-capability-availability')}
    counts[availability] += 1
  }

  const sample = capabilityRows
    .filter(entry => string(entry.platform.availability) !== 'unknown')
    .slice(0, 8)
    .map(entry => ({
      id: string(entry.row.capability),
      availability: string(entry.platform.availability) as ShellViewportModel['capability_sample'][number]['availability'],
      owner: string(entry.platform.owner),
      reason: string(entry.platform.reason)
    }))

  const qualification = object(cell.qualification_state) ? cell.qualification_state : {}

  const shellTargets = array(builds.cells)
    .filter(row => object(row) && row.shell === request.shell_id)
    .map(row => string((row as Record<string, unknown>).target))
    .filter(Boolean)

  const compatibleSurfaces = array(surfaces.profiles)
    .filter(object)
    .filter(row => compatible(request.shell_id, buildPlatform, array(row.productionHosts).map(string)))
    .map(row => string(row.id))

  const shellIds = array(builds.shells).filter(object).map(row => string(row.id))

  return {
    schema: 'ae-shell-viewport-model/1',
    authority: 'none',
    source_hashes: { builds: hash(builds), capabilities: hash(capabilities), surfaces: hash(surfaces) },
    shell: {
      id: request.shell_id,
      owner: string(shell.owner),
      platform: buildPlatform,
      manifest: string(shell.manifest)
    },
    surface: {
      id: request.surface_profile_id,
      name: string(surface.name),
      form_factor: string(surface.formFactor) as ShellViewportModel['surface']['form_factor'],
      production_hosts: productionHosts,
      geometry: object(surface.geometry) ? surface.geometry : {},
      safe_area: object(surface.safeArea) ? surface.safeArea : {},
      corner_radii: object(surface.cornerRadii) ? surface.cornerRadii : {},
      chrome: array(surface.chrome).map(string),
      window_policy: string(surface.windowPolicy),
      sources: array(surface.sources).filter(object)
    },
    target: {
      id: request.target_id,
      cell_id: string(cell.id),
      architecture: string(target.row.architecture),
      sdk: string(target.row.sdk),
      abi: typeof target.row.abi === 'string' ? target.row.abi : null,
      package: string(target.row.package),
      artifact_kind: string(target.row.artifact_kind),
      disposition: string(cell.disposition),
      owner_ref: string(cell.artifact_owner),
      reason: string(cell.reason),
      rungs: {
        source: string(qualification.source),
        artifact: string(qualification.artifact),
        package_install: string(qualification.package_install),
        physical_runtime: string(qualification.physical_runtime)
      }
    },
    capability_summary: counts,
    capability_sample: sample,
    posture: 'structural-projection',
    warning: 'STRUCTURAL PROJECTION — NOT A PHYSICAL RUN',
    selector: { shells: shellIds, surfaces: compatibleSurfaces, targets: shellTargets }
  }
}

const text = (id: string, value: string, size: 'm' | 's' = 's'): SceneNode => ({ id, p: 'text', a: { text: value, size } })

const button = (id: string, label: string, action: string, primary = false): SceneNode => ({
  id,
  p: 'button',
  a: { label, primary },
  on: { tap: action }
})

export function composeShellViewportScene(model: ShellViewportModel): ShellViewportScene {
  const nodes: SceneNode[] = []
  const rootKids = ['warning', 'selectors', 'viewport', 'evidence', 'capabilities']
  nodes.push({ id: 'shell-root', p: 'column', kids: rootKids })
  nodes.push(text('warning', model.warning, 'm'))

  const selectorKids: string[] = []

  for (const id of model.selector.shells) {
    const nodeId = `shell-target-${id}`
    selectorKids.push(nodeId)
    nodes.push(button(nodeId, id, `shell.target.${id}`, id === model.shell.id))
  }

  for (const id of model.selector.surfaces) {
    const nodeId = `shell-surface-${id}`
    selectorKids.push(nodeId)
    nodes.push(button(nodeId, id, `shell.surface.${id}`, id === model.surface.id))
  }

  for (const id of model.selector.targets) {
    const nodeId = `shell-build-${id}`
    selectorKids.push(nodeId)
    nodes.push(button(nodeId, id, `shell.build.${id}`, id === model.target.id))
  }

  nodes.push({ id: 'selectors', p: 'row', kids: selectorKids })

  const viewportKids = ['viewport-title', 'viewport-native', 'viewport-demo-title', 'viewport-demo-body', 'viewport-demo-action']
  nodes.push({ id: 'viewport', p: 'column', kids: viewportKids, layout: { height: '*' } })
  nodes.push(text('viewport-title', `${model.surface.name} · ${model.target.id}`, 'm'))
  nodes.push({
    id: 'viewport-native',
    p: 'native',
    a: {
      catalog: 'shell-structural-viewport',
      model: {
        schema: model.schema,
        shell_id: model.shell.id,
        surface_profile_id: model.surface.id,
        form_factor: model.surface.form_factor,
        geometry: model.surface.geometry,
        safe_area: model.surface.safe_area,
        corner_radii: model.surface.corner_radii,
        chrome: model.surface.chrome,
        window_policy: model.surface.window_policy,
        warning: model.warning
      }
    },
    layout: { height: '*' }
  })
  nodes.push(text('viewport-demo-title', 'Same semantic GenUI experience', 'm'))
  nodes.push(text('viewport-demo-body', 'One card identity. Shell geometry and capability posture vary; meaning and action stay fixed.'))
  nodes.push(button('viewport-demo-action', 'Inspect evidence', 'shell.inspect'))

  const rungKids = Object.entries(model.target.rungs).map(([key, value]) => {
    const id = `rung-${key.replaceAll('_', '-')}`
    nodes.push(text(id, `${key.replaceAll('_', ' ')} · ${value}`))

    return id
  })

  nodes.push({ id: 'evidence', p: 'column', kids: ['target-owner', 'target-reason', ...rungKids] })
  nodes.push(text('target-owner', `Owner · ${model.target.owner_ref}`))
  nodes.push(text('target-reason', model.target.reason))

  const capabilityKids = Object.entries(model.capability_summary).map(([key, value]) => {
    const id = `capability-${key}`
    nodes.push(text(id, `${key} · ${value}`))

    return id
  })

  nodes.push({ id: 'capabilities', p: 'column', kids: capabilityKids })

  return {
    sceneVersion: '1.0.0',
    id: 'shell-viewport',
    root: 'shell-root',
    nodes,
    receipt: {
      schema: 'ae-shell-viewport-receipt/1',
      authority: 'none',
      posture: model.posture,
      source_hashes: model.source_hashes
    }
  }
}
