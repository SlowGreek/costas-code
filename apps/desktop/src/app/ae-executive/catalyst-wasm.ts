// Catalyst's UGUI client bootstrap.
//
// Same shape as projects/js/projects-wasm.js: this file holds element handles,
// exposes the capabilities Rust cannot reach, and enacts typed effects. It
// makes no decision about admission, freshness, tab selection, what a gesture
// means, or what may leave the client — all of that is in catalyst/wasm.

import initWasm, {
  catalyst_controller_dispatch_action,
  catalyst_controller_dispatch_event,
  catalyst_controller_init,
  catalyst_controller_observe,
  catalyst_controller_paint,
  catalyst_controller_select_tab,
  catalyst_document_action,
  catalyst_document_source,
  catalyst_global_key,
  catalyst_mount_document,
  catalyst_mount_l2_document,
  catalyst_overlay_clear,
  catalyst_overlay_close,
  catalyst_overlay_push,
  catalyst_overlay_snapshot,
  catalyst_preference_selection,
  catalyst_preference_vocabulary,
  catalyst_profile_css,
  catalyst_projects_input,
  catalyst_set_active_skin,
  catalyst_set_asset_base,
  catalyst_skin_field,
  catalyst_skin_variables,
  catalyst_tab_document,
  catalyst_tabs
} from '../../../public/wasm/catalyst_wasm.js'

/** One semantic gesture on a painted Document. */
export interface UguiDocumentEvent {
  readonly schema: 'ugui-document-event/1'
  readonly document_id: string
  readonly item_id: string
  readonly gesture: 'change' | 'focus' | 'key' | 'submit' | 'tap'
  readonly action: string
  readonly payload: unknown
}

export interface LucidActionIntent {
  readonly schema: 'hermes-lucid-executive-intent/1'
  readonly verb: string
  readonly payload: Record<string, unknown>
  readonly expected_generation: number
  readonly expected_document_hash: string
  readonly operation_id: string
}

export type LucidActionResult =
  | { readonly result: unknown; readonly lucid_receipt: Record<string, unknown> }
  | { readonly error: string; readonly lucid_receipt: Record<string, unknown> }
  | { readonly error: string; readonly code: string; readonly retryable: false }

export interface CatalystTab {
  readonly id: string
  readonly source: string
  readonly app: string
  readonly label: string
  readonly mnemonic: string
  readonly live: boolean
  readonly batch: boolean
}

export interface CatalystEffect {
  readonly kind: 'tab.select' | 'paint' | 'lucid.intent' | 'studio.submit' | 'refused'
  readonly tab?: string
  readonly intent?: Record<string, unknown>
  readonly event?: Record<string, unknown>
  readonly revision?: number
  readonly documentHash?: string
  readonly code?: string
  readonly detail?: string
}

export interface CatalystRow {
  readonly tab: string
  readonly state: 'fresh' | 'stale' | 'unavailable' | 'fixture' | 'structural'
  readonly code: string | null
  readonly preserved: boolean
  readonly hasDocument: boolean
}

export interface CatalystBatch {
  readonly authority: string
  readonly generation: number | null
  readonly observedMs: number | null
  readonly freshness: string
  readonly posture: string
  readonly artifactGeneration: string
  readonly rows: readonly CatalystRow[]
}

export interface CatalystReceipt {
  readonly error?: string
  readonly detail?: string
  readonly accepted?: boolean
  readonly reason?: string
  readonly batch?: CatalystBatch | null
  readonly effects?: readonly CatalystEffect[]
}

// The only capabilities Rust cannot reach: host-owned globals and IPC.
const HOST_ADAPTER = {
  documents: () => window.hermesDesktop.getAeExecutiveDocuments(),
  intent: (request: unknown) => window.hermesDesktop.executeLucidExecutiveIntent(request as never),
  studio: (request: unknown) => window.hermesDesktop.submitStudioDesignerEvent(request as never),
  operationId: () => globalThis.crypto.randomUUID()
}

let ready: Promise<void> | null = null
let root: Element | null = null
let listener: ((effect: CatalystEffect) => void) | null = null
let seated = false
// Tests load the engine from bytes; the app resolves it from its own URL.
let wasmInput: unknown

export function setWasmInputForTests(input: unknown) {
  wasmInput = input
}

/** A file:// renderer has no site root, so Document assets resolve against it. */
export function setAssetBaseForTests(base: string): void {
  catalyst_set_asset_base(base)
}

export function assetBase(): string {
  const location = globalThis.location

  return location?.protocol === 'file:' ? new URL('.', location.href).href : '/'
}

/** Bring the engine up before anything asks it to answer synchronously. */
export function startEngine(): Promise<void> {
  return start()
}

/** The shell's CSS variables for a normalized profile, answered by the engine. */
export function profileCss(axes: unknown, mode: RenderMode): Record<string, string> {
  return JSON.parse(catalyst_profile_css(JSON.stringify(axes ?? null), mode)) as Record<
    string,
    string
  >
}

/** Light and dark are one skin read two ways, so the engine is told which. */
export type RenderMode = 'light' | 'dark'

export interface KeyDecision {
  readonly kind: string
  readonly value?: unknown
}

/** What a keystroke means. The engine decides; this host only carries it out. */
export function globalKey(
  key: string,
  modifiers: { meta: boolean; control: boolean; alt: boolean },
  executable = false
): KeyDecision {
  return JSON.parse(
    catalyst_global_key(key, modifiers.meta, modifiers.control, modifiers.alt, executable)
  ) as KeyDecision
}

/** What the engine's Document stack is currently showing. */
export interface OverlayStack {
  readonly depth: number
  readonly current: unknown
  readonly selectedApp: string | null
}

const overlayStack = (encoded: string): OverlayStack => {
  const answer = JSON.parse(encoded) as Partial<OverlayStack>

  return {
    depth: answer.depth ?? 0,
    current: answer.current ?? null,
    selectedApp: answer.selectedApp ?? null
  }
}

/** Open a Document over whatever is already open. */
export function overlayPush(document: unknown): OverlayStack {
  return overlayStack(catalyst_overlay_push(JSON.stringify(document ?? null)))
}

/** Close the showing Document; the engine decides whether a parent remains. */
export function overlayClose(): OverlayStack {
  return overlayStack(catalyst_overlay_close())
}

export function overlayClear(): OverlayStack {
  return overlayStack(catalyst_overlay_clear())
}

export function overlaySnapshot(): OverlayStack {
  return overlayStack(catalyst_overlay_snapshot())
}

/** Which control of each preference group is currently committed. */
export function preferenceSelection(active: Record<string, string>): Record<string, string> {
  const answer = JSON.parse(catalyst_preference_selection(JSON.stringify(active))) as {
    selected?: Record<string, string>
  }

  return answer.selected ?? {}
}

/** One preference's control group, and the applet input that carries it. */
export interface PreferenceEntry {
  readonly action: string | null
  readonly choices: string[] | null
  readonly appletInput: string | null
}

/** The choices each preference admits, so this host validates nothing itself. */
export function preferenceVocabulary(): Record<string, PreferenceEntry> {
  const answer = JSON.parse(catalyst_preference_vocabulary()) as {
    preferences?: Record<string, PreferenceEntry>
  }

  return answer.preferences ?? {}
}

/** Apply one Skin Studio field edit and get the repainted variables back. */
export function skinField(
  skinId: string,
  nodeId: string,
  value: unknown,
  mode: RenderMode
): Record<string, string> | null {
  const answer = JSON.parse(
    catalyst_skin_field(skinId, nodeId, JSON.stringify(value ?? null), mode)
  ) as {
    variables?: Record<string, string>
  }

  return answer.variables ?? null
}

/**
 * Every variable a catalogued skin projects — the vocabulary names a painted
 * Document reads as well as the shell's own. Null when the engine does not
 * carry the skin, so the caller can fall back to the host's normalized axes.
 */
export function skinCss(skinId: string, mode: RenderMode): Record<string, string> | null {
  const answer = JSON.parse(catalyst_skin_variables(skinId, mode)) as {
    variables?: Record<string, string>
  }

  return answer.variables ?? null
}

/** The attributes a skin implies. Rules keyed on chrome state need these. */
export function skinAttributes(skinId: string, mode: RenderMode): Record<string, string> {
  const answer = JSON.parse(catalyst_skin_variables(skinId, mode)) as {
    attributes?: Record<string, string>
  }

  return answer.attributes ?? {}
}

/** Tell the engine which skin is showing, so the Studio opens on it. */
export function setActiveSkin(skinId: string): void {
  catalyst_set_active_skin(skinId)
}

function start(): Promise<void> {
  return (ready ??= initWasm(wasmInput as never).then(() => {
    catalyst_set_asset_base(assetBase())
  }))
}

function check(encoded: string): CatalystReceipt {
  const receipt = JSON.parse(encoded) as CatalystReceipt

  if (receipt.error) {throw new Error(`${receipt.error}:${receipt.detail ?? ''}`)}

  return receipt
}

export function init(element: Element, tabs: readonly string[]): Promise<void> {
  root = element

  return start().then(() => {
    // Seat once: re-seating would discard the admitted batch Rust holds.
    if (!seated) {
      check(catalyst_controller_init(JSON.stringify(tabs)))
      seated = true
    }
  })
}

export function onEffect(handler: ((effect: CatalystEffect) => void) | null) {
  listener = handler
}

/** Pull one envelope from the host and let Rust admit and reconcile it. */
export async function observe(): Promise<CatalystReceipt> {
  const envelope = await HOST_ADAPTER.documents()
  const receipt = check(catalyst_controller_observe(JSON.stringify(envelope)))
  await enact(receipt.effects)

  return receipt
}

export async function selectTab(tab: string): Promise<CatalystReceipt> {
  const receipt = check(catalyst_controller_select_tab(tab))
  await enact(receipt.effects)

  return receipt
}

export async function dispatchAction(action: string): Promise<CatalystReceipt> {
  const receipt = check(catalyst_controller_dispatch_action(action, HOST_ADAPTER.operationId()))
  await enact(receipt.effects)

  return receipt
}

export async function dispatchEvent(event: unknown): Promise<CatalystReceipt> {
  const receipt = check(
    catalyst_controller_dispatch_event(JSON.stringify(event), HOST_ADAPTER.operationId())
  )

  await enact(receipt.effects)

  return receipt
}

export function paint(): void {
  if (root) {check(catalyst_controller_paint(root))}
}

/** Paint one Document the controller does not own, with the same engine. */
export function mountDocument(element: Element, document: unknown): Promise<void> {
  return start().then(() => {
    check(catalyst_mount_document(element, JSON.stringify(document)))
  })
}

/** Paint a nested Document with the engine's title chrome and content partition. */
export function mountL2Document(element: Element, document: unknown): Promise<void> {
  return start().then(() => {
    check(catalyst_mount_l2_document(element, JSON.stringify(document)))
  })
}

/** The authored tab set from catalyst/TABS.json. */
export function tabsJson(): Promise<string> {
  return start().then(() => catalyst_tabs())
}

export function loadTabs(): Promise<readonly CatalystTab[]> {
  return tabsJson().then(encoded => (JSON.parse(encoded) as { tabs: CatalystTab[] }).tabs)
}

/** Paint a catalog tab straight from the shared catalog. */
export function paintCatalogTab(tabId: string): Promise<void> {
  if (!root) {return Promise.resolve()}

  return tabDocument(tabId).then(document => mountDocument(root as Element, JSON.parse(document)))
}

/** One catalog tab's Document, painted by the engine rather than composed here. */
export function tabDocument(tabId: string): Promise<string> {
  return start().then(() => catalyst_tab_document(tabId))
}

/**
 * Every gesture the engine can bind. Pinned to the canon by the Rust test
 * `every_gesture_is_a_dom_event_a_host_can_listen_for`.
 */
export const UGUI_GESTURES = ['click', 'change', 'input'] as const

export interface UguiHit {
  readonly action: string
  readonly itemId: string
  readonly source: string | null
  readonly value: unknown
}

/**
 * Resolve the action an event landed on. The engine paints the gesture that
 * commits each control, so a dropdown is heard on `change` and a button on
 * `click` without the host knowing which is which.
 */
export function uguiActionFromEvent(target: EventTarget | null, gesture: string): UguiHit | null {
  const element = (target as HTMLElement | null)?.closest?.('[data-ugui-action]')
  const action = element?.getAttribute('data-ugui-action')

  if (!action || (element?.getAttribute('data-ugui-gesture') ?? 'click') !== gesture) {return null}

  const source = element?.getAttribute('data-ugui-source') ?? null
  const control = element as HTMLInputElement | HTMLSelectElement | null

  return {
    action,
    itemId: element?.getAttribute('data-ugui-id') ?? '',
    source,
    // A control that commits a value carries it; a press is named by its source.
    value: gesture === 'click' ? source : (control?.value ?? source)
  }
}

export interface DocumentAction {
  readonly schema: string
  readonly kind:
    | 'none'
    | 'open-document'
    | 'external'
    | 'system-app'
    | 'preference'
    | 'skin'
    | 'media'
    | 'handler'
    | 'refused'
  readonly source?: string
  readonly url?: string
  readonly name?: string
  readonly preference?: string
  readonly operation?: string
  readonly intent?: string
  readonly channel?: string
  readonly handler?: string
  readonly nodeId?: string
  readonly value?: unknown
  readonly code?: string
  readonly detail?: string
}

/** What a painted Document's action means, answered by the engine. */
export function documentAction(action: string, nodeId: string, value: unknown): DocumentAction {
  return JSON.parse(catalyst_document_action(action, nodeId, JSON.stringify(value ?? null))) as DocumentAction
}

/** How the engine says the seated surface is presented. */
export interface SurfaceFrame {
  readonly id: string
  readonly renderMode: string
  readonly appletSurface: string
  readonly overlay: boolean
  readonly wearable: boolean
  readonly resizable: boolean
}

export interface ProjectsFrame {
  readonly schema: string
  readonly status?: string
  readonly seated?: boolean
  readonly document?: unknown
  readonly surface?: SurfaceFrame
  readonly error?: string
  readonly detail?: string
}

/** Drive the seated Projects applet; the engine returns the next Document. */
export function projectsInput(handler: string, nodeId: string, value: unknown): ProjectsFrame {
  return JSON.parse(
    catalyst_projects_input(handler, nodeId, JSON.stringify(value ?? null))
  ) as ProjectsFrame
}

/** Resolve one engine-carried nested Document without choosing its presentation. */
export function loadDocumentSource(source: string): Promise<unknown> {
  if (!/^\/apps\/[a-z0-9-]+\.json$/.test(source)) {
    return Promise.reject(new Error(`document source is not admitted: ${source}`))
  }

  // The engine carries these documents, so opening one is neither a fetch nor a
  // read of a staged copy of the projects folder.
  return start().then((): unknown => {
    const carried = JSON.parse(catalyst_document_source(source)) as { error?: string }

    if (carried.error) {
      throw new Error(`document source is not carried: ${source}`)
    }

    return carried
  })
}

/** A nested-card names another authored Document; paint it as ordinary content. */
export function openDocumentSource(element: Element, source: string): Promise<void> {
  return loadDocumentSource(source).then(document => mountDocument(element, document))
}

async function enact(effects: readonly CatalystEffect[] = []): Promise<void> {
  for (const effect of effects) {
    switch (effect.kind) {
      case 'paint':
        paint()

        break

      case 'lucid.intent':
        await HOST_ADAPTER.intent(effect.intent)

        break

      case 'studio.submit':
        await HOST_ADAPTER.studio({
          event: effect.event,
          context: { revision: effect.revision, documentHash: effect.documentHash }
        })

        break

      case 'tab.select':

      case 'refused':
        break
    }

    listener?.(effect)
  }
}

export function resetForTests(): void {
  root = null
  listener = null
  seated = false
}
