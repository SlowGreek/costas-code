export const AE_EXECUTIVE_TAB_IDS = [
  'home',
  'dashboard',
  'lucid',
  'quine',
  'scores',
  'metrics',
  'logs',
  'studio',
  'settings',
  'marketplace',
  'shell'
] as const

export type AeExecutiveTabId = (typeof AE_EXECUTIVE_TAB_IDS)[number]
export const AE_EXECUTIVE_BATCH_TAB_IDS = AE_EXECUTIVE_TAB_IDS.filter(
  (id): id is Exclude<AeExecutiveTabId, 'shell'> => id !== 'shell'
)

export interface AeExecutiveTab {
  readonly id: AeExecutiveTabId
  readonly label: string
  readonly mnemonic: string
  readonly route: `/ae/${AeExecutiveTabId}`
  readonly icon: string
  readonly summary: string
}

export const AE_EXECUTIVE_TABS: readonly AeExecutiveTab[] = [
  {
    id: 'home',
    label: '[H]OME',
    mnemonic: 'H',
    route: '/ae/home',
    icon: 'home',
    summary: 'Resident executive overview and profile identity.'
  },
  {
    id: 'dashboard',
    label: '[D]ASHBOARD',
    mnemonic: 'D',
    route: '/ae/dashboard',
    icon: 'dashboard',
    summary: 'Readiness lattice, active work, and system topology.'
  },
  {
    id: 'lucid',
    label: '[L]UCID',
    mnemonic: 'L',
    route: '/ae/lucid',
    icon: 'lightbulb',
    summary: 'Typed executive verbs and receipt-bearing operations.'
  },
  {
    id: 'quine',
    label: '[Q]UINE',
    mnemonic: 'Q',
    route: '/ae/quine',
    icon: 'symbol-structure',
    summary: 'Acceptance, evidence, dispatch, and recursive improvement.'
  },
  {
    id: 'scores',
    label: 'S[C]ORES',
    mnemonic: 'C',
    route: '/ae/scores',
    icon: 'graph-line',
    summary: 'Alignment scoreboards and exact completion identity.'
  },
  {
    id: 'metrics',
    label: '[M]ETRICS',
    mnemonic: 'M',
    route: '/ae/metrics',
    icon: 'pulse',
    summary: 'Resource, readiness, and fidelity evidence.'
  },
  {
    id: 'logs',
    label: 'L[O]GS',
    mnemonic: 'O',
    route: '/ae/logs',
    icon: 'output',
    summary: 'Bounded operational journal and fault evidence.'
  },
  {
    id: 'studio',
    label: 'S[T]UDIO',
    mnemonic: 'T',
    route: '/ae/studio',
    icon: 'beaker',
    summary: 'UGUI applets, native surfaces, and development workbench.'
  },
  {
    id: 'settings',
    label: '[S]ETTINGS',
    mnemonic: 'S',
    route: '/ae/settings',
    icon: 'settings-gear',
    summary: 'Profile-scoped executive presentation policy.'
  },
  {
    id: 'marketplace',
    label: 'MA[R]KETPLACE',
    mnemonic: 'R',
    route: '/ae/marketplace',
    icon: 'extensions',
    summary: 'Discover, inspect, and pin qualified UGUI applets.'
  },
  {
    id: 'shell',
    label: 'SH[E]LL',
    mnemonic: 'E',
    route: '/ae/shell',
    icon: 'device-desktop',
    summary: 'Project one semantic experience through explicit shell, surface, and capability constraints.'
  }
] as const

export const AE_EXECUTIVE_ROUTE_SET: ReadonlySet<string> = new Set(AE_EXECUTIVE_TABS.map(tab => tab.route))

export function isAeExecutiveTabId(value: string | undefined): value is AeExecutiveTabId {
  return Boolean(value && (AE_EXECUTIVE_TAB_IDS as readonly string[]).includes(value))
}

export function aeExecutiveTab(value: string | undefined): AeExecutiveTab {
  return AE_EXECUTIVE_TABS.find(tab => tab.id === value) ?? AE_EXECUTIVE_TABS[0]
}
