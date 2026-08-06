import tabsDocument from '../../../../../TABS.json'

export interface AeExecutiveTab {
  readonly id: AeExecutiveTabId
  readonly label: string
  readonly mnemonic: string
  readonly route: `/ae/${AeExecutiveTabId}`
  readonly icon: string
  readonly summary: string
}

interface AuthoredTab {
  readonly id: string
  readonly source: string
  readonly label: string
  readonly mnemonic: string
  readonly icon: string
  readonly summary: string
}

const AUTHORED_TABS = (tabsDocument as { tabs: AuthoredTab[] }).tabs

// TABS.json names icons semantically for every surface; this host draws codicons.
const CODICON: Record<string, string> = {
  home: 'home',
  dashboard: 'dashboard',
  lucid: 'lightbulb',
  quine: 'symbol-structure',
  scores: 'graph-line',
  metrics: 'pulse',
  logs: 'output',
  github: 'github',
  studio: 'beaker',
  settings: 'settings-gear',
  marketplace: 'extensions',
  shell: 'device-desktop',
  mermaid: 'graph-line',
  projects: 'project'
}

export type AeExecutiveTabId = string
export const AE_EXECUTIVE_TAB_IDS = AUTHORED_TABS.map(tab => tab.id)

/// A catalog tab is painted from a static document, so the executive envelope
/// carries no row for it. Mirrors `Tab::in_batch` in catalyst/wasm.
export const AE_EXECUTIVE_BATCH_TAB_IDS = AUTHORED_TABS.filter(
  tab => tab.source === 'run' || tab.source === 'host'
).map(tab => tab.id)

export const AE_EXECUTIVE_HOST_DERIVED_TAB_IDS = [] as const

export const AE_EXECUTIVE_TABS: readonly AeExecutiveTab[] = AUTHORED_TABS.map(tab => ({
  id: tab.id,
  label: tab.label,
  mnemonic: tab.mnemonic,
  route: `/ae/${tab.id}`,
  icon: CODICON[tab.icon] ?? tab.icon,
  summary: tab.summary
}))

export const AE_EXECUTIVE_ROUTE_SET: ReadonlySet<string> = new Set(AE_EXECUTIVE_TABS.map(tab => tab.route))

export function isAeExecutiveTabId(value: string | undefined): value is AeExecutiveTabId {
  return Boolean(value && (AE_EXECUTIVE_TAB_IDS as readonly string[]).includes(value))
}

export function aeExecutiveTab(value: string | undefined): AeExecutiveTab {
  return AE_EXECUTIVE_TABS.find(tab => tab.id === value) ?? AE_EXECUTIVE_TABS[0]
}
