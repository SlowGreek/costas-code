import { AE_EXECUTIVE_TABS } from '@/app/ae-executive/contract'
import { requestKeybindAction } from '@/lib/keybinds/actions'

export const VOICE_DEV_CONTROL_SCHEMA = 'hermes-dev-control-intent/1' as const
const VOICE_DEV_CONTROL_EVENT = 'hermes:voice-dev-control'

interface VoiceDevControlBase {
  schema: typeof VOICE_DEV_CONTROL_SCHEMA
  lane: 'twitch'
  phrase_id: string
}

export interface VoiceDevNavigateIntent extends VoiceDevControlBase {
  action: 'navigate'
  route: `/ae/${string}`
}

export interface VoiceDevInvokeIntent extends VoiceDevControlBase {
  action: 'invoke'
  action_id: 'nav.commandPalette' | 'view.showFiles' | 'view.showTerminal'
}

export type VoiceDevControlIntent = VoiceDevInvokeIntent | VoiceDevNavigateIntent

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')

const spokenLabel = (label: string) => normalize(label.replaceAll('[', '').replaceAll(']', ''))
const PHRASE_TABLE = new Map<string, VoiceDevControlIntent>()
const INTENT_KEYS = new Set<string>()

const add = (phrase: string, intent: VoiceDevControlIntent) => {
  PHRASE_TABLE.set(normalize(phrase), intent)
  INTENT_KEYS.add(intentKey(intent))
}

for (const tab of AE_EXECUTIVE_TABS) {
  const name = spokenLabel(tab.label)

  for (const verb of ['open', 'show', 'go to'] as const) {
    add(`${verb} ${name}`, {
      schema: VOICE_DEV_CONTROL_SCHEMA,
      lane: 'twitch',
      action: 'navigate',
      phrase_id: `nav.${tab.id}.${verb === 'go to' ? 'goto' : verb}`,
      route: tab.route
    })
  }
}

for (const [phrase, phraseId, actionId] of [
  ['open command palette', 'view.command-palette.open', 'nav.commandPalette'],
  ['show command palette', 'view.command-palette.show', 'nav.commandPalette'],
  ['show files', 'view.files.show', 'view.showFiles'],
  ['open files', 'view.files.open', 'view.showFiles'],
  ['show terminal', 'view.terminal.show', 'view.showTerminal'],
  ['open terminal', 'view.terminal.open', 'view.showTerminal']
] as const) {
  add(phrase, {
    schema: VOICE_DEV_CONTROL_SCHEMA,
    lane: 'twitch',
    action: 'invoke',
    phrase_id: phraseId,
    action_id: actionId
  })
}

function intentKey(intent: VoiceDevControlIntent): string {
  const target = intent.action === 'navigate' ? intent.route : intent.action_id

  return `${intent.schema}\0${intent.lane}\0${intent.action}\0${intent.phrase_id}\0${target}`
}

function isVoiceDevControlIntent(value: unknown): value is VoiceDevControlIntent {
  if (!value || typeof value !== 'object') {
    return false
  }

  const intent = value as Partial<VoiceDevControlIntent>

  return (
    intent.schema === VOICE_DEV_CONTROL_SCHEMA &&
    intent.lane === 'twitch' &&
    typeof intent.phrase_id === 'string' &&
    (intent.action === 'navigate' || intent.action === 'invoke') &&
    INTENT_KEYS.has(intentKey(intent as VoiceDevControlIntent))
  )
}

export function matchVoiceDevControl(transcript: string): VoiceDevControlIntent | null {
  if (!transcript || transcript.length > 256 || transcript.includes('\u0000')) {
    return null
  }

  return PHRASE_TABLE.get(normalize(transcript)) ?? null
}

export function dispatchVoiceDevControl(transcript: string): boolean {
  const intent = matchVoiceDevControl(transcript)

  if (!intent || typeof window === 'undefined') {
    return false
  }

  window.dispatchEvent(new CustomEvent<VoiceDevControlIntent>(VOICE_DEV_CONTROL_EVENT, { detail: intent }))

  return true
}

export function executeVoiceDevControlIntent(intent: VoiceDevControlIntent, navigate: (route: string) => void): boolean {
  if (intent.action === 'navigate') {
    navigate(intent.route)

    return true
  }

  return requestKeybindAction(intent.action_id)
}

export function onVoiceDevControlIntent(handler: (intent: VoiceDevControlIntent) => void): () => void {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const listener = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail

    if (isVoiceDevControlIntent(detail)) {
      handler(detail)
    }
  }

  window.addEventListener(VOICE_DEV_CONTROL_EVENT, listener)

  return () => window.removeEventListener(VOICE_DEV_CONTROL_EVENT, listener)
}
