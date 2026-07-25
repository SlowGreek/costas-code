import type { AeExecutiveTabId } from './contract'

export type AeScenePrimitive = 'button' | 'column' | 'divider' | 'input' | 'progress' | 'row' | 'text'

interface AeSceneNodeBase {
  readonly id: string
  readonly p: AeScenePrimitive
}

export interface AeSceneContainerNode extends AeSceneNodeBase {
  readonly p: 'column' | 'row'
  readonly kids: readonly string[]
  readonly a?: { readonly gap?: number }
}

export interface AeSceneTextNode extends AeSceneNodeBase {
  readonly p: 'text'
  readonly a: {
    readonly text: string
    readonly size?: 's' | 'm' | 'l' | 'xl'
    readonly weight?: 'bold'
    readonly tone?: 'muted' | 'normal' | 'positive' | 'warning'
  }
}

export interface AeSceneButtonNode extends AeSceneNodeBase {
  readonly p: 'button'
  readonly a: { readonly label: string; readonly primary?: boolean }
  readonly on: { readonly tap: string }
}

export interface AeSceneInputNode extends AeSceneNodeBase {
  readonly p: 'input'
  readonly a: { readonly label: string; readonly placeholder: string; readonly value?: string }
  readonly on?: { readonly change: string }
}

export interface AeSceneProgressNode extends AeSceneNodeBase {
  readonly p: 'progress'
  readonly a: { readonly label: string; readonly value: number }
}

export interface AeSceneDividerNode extends AeSceneNodeBase {
  readonly p: 'divider'
}

export type AeSceneNode =
  | AeSceneButtonNode
  | AeSceneContainerNode
  | AeSceneDividerNode
  | AeSceneInputNode
  | AeSceneProgressNode
  | AeSceneTextNode

export interface AeExecutiveScene {
  readonly sceneVersion: '1.0.0'
  readonly root: string
  readonly tab: AeExecutiveTabId
  readonly revision: string
  readonly nodes: readonly AeSceneNode[]
}

const text = (
  id: string,
  value: string,
  size: AeSceneTextNode['a']['size'] = 'm',
  tone: AeSceneTextNode['a']['tone'] = 'normal',
  weight?: 'bold'
): AeSceneTextNode => ({ id, p: 'text', a: { text: value, size, tone, ...(weight ? { weight } : {}) } })

const progress = (id: string, label: string, value: number): AeSceneProgressNode => ({
  id,
  p: 'progress',
  a: { label, value }
})

const button = (id: string, label: string, action: string, primary = false): AeSceneButtonNode => ({
  id,
  p: 'button',
  a: { label, primary },
  on: { tap: action }
})

const input = (id: string, label: string, placeholder: string, action: string): AeSceneInputNode => ({
  id,
  p: 'input',
  a: { label, placeholder },
  on: { change: action }
})

const bodyByTab: Record<AeExecutiveTabId, readonly AeSceneNode[]> = {
  home: [
    text('home-title', 'AGENTEXPERIMENTS', 'xl', 'normal', 'bold'),
    text('home-subtitle', 'Native executive environment · Hermes-visible · QUINE-settled', 'm', 'muted'),
    { id: 'home-divider', p: 'divider' },
    text('home-state', 'Development organism online', 'l', 'positive', 'bold'),
    text('home-copy', 'Nine executive surfaces share one closed Scene contract. Desktop paints; AE owns meaning.'),
    progress('home-readiness', 'Executive surface readiness', 0.78),
    button('home-open-quine', 'Open QUINE', 'route:quine', true)
  ],
  dashboard: [
    text('dashboard-title', 'SYSTEM DASHBOARD', 'xl', 'normal', 'bold'),
    text('dashboard-subtitle', 'Native-edge and Hermes-visible tracks remain parallel.', 'm', 'muted'),
    { id: 'dashboard-divider', p: 'divider' },
    progress('dashboard-native', 'Native edge', 0.72),
    progress('dashboard-host', 'Visible host', 0.63),
    progress('dashboard-evidence', 'Evidence freshness', 0.91),
    text('dashboard-hold', 'HOLD · live mutation and cutover require independent acceptance.', 'm', 'warning')
  ],
  lucid: [
    text('lucid-title', 'LUCID', 'xl', 'normal', 'bold'),
    text('lucid-subtitle', 'show · get · set · morph · dispatch · steer · cancel', 'm', 'muted'),
    { id: 'lucid-divider', p: 'divider' },
    input('lucid-command', 'Typed operation', 'show pulse', 'lucid:command'),
    { id: 'lucid-actions', p: 'row', a: { gap: 8 }, kids: ['lucid-show', 'lucid-get', 'lucid-dispatch'] },
    button('lucid-show', 'show', 'lucid:show', true),
    button('lucid-get', 'get', 'lucid:get'),
    button('lucid-dispatch', 'dispatch', 'lucid:dispatch'),
    text('lucid-policy', 'Operations are descriptive until Butler admits capability and returns a receipt.', 's', 'muted')
  ],
  quine: [
    text('quine-title', 'QUINE', 'xl', 'normal', 'bold'),
    text('quine-subtitle', 'Evidence → disposition → dispatch → recursive improvement', 'm', 'muted'),
    { id: 'quine-divider', p: 'divider' },
    progress('quine-contract', 'Contract closure', 0.86),
    progress('quine-parity', 'Differential parity', 0.82),
    progress('quine-physical', 'Physical qualification', 0.41),
    { id: 'quine-actions', p: 'row', a: { gap: 8 }, kids: ['quine-pulse', 'quine-evidence'] },
    button('quine-pulse', 'Pulse', 'quine:pulse', true),
    button('quine-evidence', 'Evidence', 'quine:evidence'),
    text('quine-settlement', 'Provider completion is a candidate. QUINE acceptance settles work.', 'm', 'warning')
  ],
  scores: [
    text('scores-title', 'ALIGNMENT SCORES', 'xl', 'normal', 'bold'),
    text('scores-subtitle', 'Exactness earns. Residuals remain visible.', 'm', 'muted'),
    { id: 'scores-divider', p: 'divider' },
    progress('scores-penguin', 'Penguin · exact completion identity', 0.8),
    progress('scores-hats', 'HATS · capability alignment', 0.74),
    progress('scores-tools', 'Tools · LUCID-native coverage', 0.69),
    progress('scores-plexus', 'PLEXUS · route fidelity', 0.77)
  ],
  metrics: [
    text('metrics-title', 'AE VITALS', 'xl', 'normal', 'bold'),
    text('metrics-subtitle', 'Bounded observations; no invented energy estimate.', 'm', 'muted'),
    { id: 'metrics-divider', p: 'divider' },
    progress('metrics-readiness', 'Readiness', 0.76),
    progress('metrics-log', 'Log fidelity', 0.93),
    progress('metrics-resource', 'Resource evidence', 0.67),
    text('metrics-freshness', 'Freshness · source observations required for promotion.', 's', 'muted')
  ],
  logs: [
    text('logs-title', 'OPERATION JOURNAL', 'xl', 'normal', 'bold'),
    text('logs-subtitle', 'Content-free control evidence and bounded diagnostics.', 'm', 'muted'),
    { id: 'logs-divider', p: 'divider' },
    input('logs-filter', 'Filter', 'receipt, hold, fault…', 'logs:filter'),
    text('logs-line-1', 'GREEN · RuntimeSessionHost process-local parity', 'm', 'positive'),
    text('logs-line-2', 'ATTEST · F0c.1 source-owned prior/input capture', 'm', 'positive'),
    text('logs-line-3', 'HOLD · live F5 transport and exact close proof', 'm', 'warning')
  ],
  studio: [
    text('studio-title', 'STUDIO WORKBENCH', 'xl', 'normal', 'bold'),
    text('studio-subtitle', 'UGUI Scenes · Rust projector · native painters · applets', 'm', 'muted'),
    { id: 'studio-divider', p: 'divider' },
    { id: 'studio-actions', p: 'row', a: { gap: 8 }, kids: ['studio-preview', 'studio-validate'] },
    button('studio-preview', 'Preview Scene', 'studio:preview', true),
    button('studio-validate', 'Validate', 'studio:validate'),
    progress('studio-surface', 'Desktop painter coverage', 0.54),
    text('studio-policy', 'Arbitrary project WASM/native code is never loaded. Packaged, signed projectors only.', 's', 'warning')
  ],
  settings: [
    text('settings-title', 'EXECUTIVE SETTINGS', 'xl', 'normal', 'bold'),
    text('settings-subtitle', 'Presentation policy belongs to the active profile and window.', 'm', 'muted'),
    { id: 'settings-divider', p: 'divider' },
    button('settings-motion', 'Reduced motion · system', 'settings:motion'),
    button('settings-density', 'Density · comfortable', 'settings:density'),
    button('settings-receipts', 'Receipts · expanded', 'settings:receipts'),
    text('settings-effects', 'Authority-bearing configuration remains Butler-owned.', 's', 'muted')
  ]
}

export function executiveScene(tab: AeExecutiveTabId): AeExecutiveScene {
  const children = bodyByTab[tab]
  const root = `ae-${tab}-root`

  const nestedIds = new Set(
    children.flatMap(node => (node.p === 'column' || node.p === 'row' ? [...node.kids] : []))
  )

  const rootKids = children.filter(node => !nestedIds.has(node.id)).map(node => node.id)
  const nodes: AeSceneNode[] = [{ id: root, p: 'column', a: { gap: 14 }, kids: rootKids }, ...children]

  return {
    sceneVersion: '1.0.0',
    root,
    tab,
    revision: `ae-executive/${tab}/1`,
    nodes
  }
}
