import { JsonRpcGatewayError } from '@hermes/shared'
import { atom, computed } from 'nanostores'

import { translateNow } from '@/i18n'
import { stableArray } from '@/lib/stable-array'
import type { TodoItem, TodoStatus } from '@/lib/todos'

import { $gateway } from './gateway'
import { $goalsBySession, type SessionGoal, type GoalStatus as SessionGoalStatus } from './goals'
import { dispatchNativeNotification } from './native-notifications'
import { notifyError } from './notifications'
import { $sessions, lineageAliases } from './session'
import { $sessionStates } from './session-states'
import { $subagentsBySession, type SubagentProgress } from './subagents'
import { $todosBySession } from './todos'

/** Composer status stack feed — merged todos, subagents, background per session. */
export type StatusItemState = 'done' | 'failed' | 'running'
export type StatusItemType = 'background' | 'goal' | 'subagent' | 'todo'
// The union the status row renders from: GoalManager's authoritative lifecycle
// states plus the 'waiting' state the text-derived store can report.
export type GoalStatus = SessionGoalStatus | 'blocked' | 'cleared'

export interface GatewayGoalStatus {
  blocked_reason?: null | string
  goal: string
  last_reason?: null | string
  max_turns: number
  paused_reason?: null | string
  status: GoalStatus
  turns_used: number
  waiting_reason?: null | string
}

export interface ComposerStatusItem {
  /** background: non-zero exit shown inline when failed. */
  exitCode?: number
  /** subagent: active tool label shown on the right. */
  currentTool?: string
  /** Goal: compact progress / latest judge reason shown after the title. */
  detail?: string
  /** Goal: a reason that needs room to be read (blocked / paused). Rendered as
   *  a wrapped block UNDER the row instead of being truncated into it — a
   *  blocked goal's reason is the one thing the user must act on, so it must
   *  never be clipped to "The agent has stopped iterating, stating S…". */
  detailNote?: string
  /** Goal: lifecycle state driving its glyph/tone —
   *  active | blocked | cleared | done | paused | waiting. */
  goalStatus?: GoalStatus
  id: string
  /** background process: captured stdout/stderr tail for the inline viewer. */
  output?: string
  /** subagent: its own stored session id — row click opens that session window
   *  (livestreamed by the gateway's child-session mirror). */
  sessionId?: string
  state: StatusItemState
  title: string
  /** todo: the full four-state status driving the row's checkmark glyph. */
  todoStatus?: TodoStatus
  type: StatusItemType
}

// Writable source for background work, synced from the gateway's process
// registry (`terminal(background=true)` spawns) via `process.list`.
export const $backgroundStatusBySession = atom<Record<string, ComposerStatusItem[]>>({})
export const $goalStatusBySession = atom<Record<string, GatewayGoalStatus>>({})

// Stored session ids that have at least one RUNNING background process. The
// sidebar row reads this for a hollow dot — distinct from the filled dot of an
// active LLM turn — so the user can tell at a glance "this session has
// something chugging along in the background" even when the turn is idle.
//
// $backgroundStatusBySession is keyed by RUNTIME session id (gateway events
// and process.list both speak that); the sidebar row knows only the STORED id.
// $sessionStates bridges the two: runtime id → state.storedSessionId, then
// lineageAliases covers whichever tip of that conversation a surface holds.
// Perf: recomputes on every $sessionStates change (message deltas, tens/sec),
// but the background-running set rarely moves. `stableArray` keeps the prior
// reference when unchanged so rows reading this don't re-render per token.
let backgroundRunningIds: readonly string[] = []
export const $backgroundRunningSessionIds = computed(
  [$backgroundStatusBySession, $sessionStates, $sessions],
  (bg, states, sessions) => {
    const ids = new Set<string>()

    for (const [runtimeId, items] of Object.entries(bg)) {
      if (!items.some(i => i.state === 'running')) {
        continue
      }

      // Same fresh-chat fallback as the working/attention projections: before a
      // conversation is persisted its runtime id is the id surfaces key on.
      for (const alias of lineageAliases(states[runtimeId]?.storedSessionId ?? runtimeId, sessions)) {
        ids.add(alias)
      }
    }

    return (backgroundRunningIds = stableArray(backgroundRunningIds, [...ids]))
  }
)

// Rows the user X-ed away. The registry keeps finished processes around for a
// while, so without this every refresh would resurrect a dismissed row.
const dismissedBySession = new Map<string, Set<string>>()

// Finished tasks self-clear so the stack only ever holds running work. Success
// goes quick; failure lingers longer so its exit code stays readable (the output
// also lives in the transcript). A manual X still drops either at once.
const SUCCESS_LINGER_MS = 4_000
const FAILURE_LINGER_MS = 12_000
const autoClearTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>()

function scheduleAutoDismiss(sid: string, id: string, delayMs: number) {
  let timers = autoClearTimers.get(sid)

  if (timers?.has(id)) {
    return
  }

  if (!timers) {
    timers = new Map()
    autoClearTimers.set(sid, timers)
  }

  timers.set(
    id,
    setTimeout(() => {
      autoClearTimers.get(sid)?.delete(id)
      dismissBackgroundProcess(sid, id)
    }, delayMs)
  )
}

function cancelAutoDismiss(sid: string, id: string) {
  const timers = autoClearTimers.get(sid)

  if (!timers) {
    return
  }

  const timer = timers.get(id)

  if (timer !== undefined) {
    clearTimeout(timer)
    timers.delete(id)
  }
}

function cancelAllAutoDismiss(sid: string) {
  const timers = autoClearTimers.get(sid)

  if (!timers) {
    return
  }

  for (const timer of timers.values()) {
    clearTimeout(timer)
  }

  autoClearTimers.delete(sid)
}

const subToItem = (s: SubagentProgress): ComposerStatusItem => ({
  currentTool: s.currentTool,
  id: s.id,
  sessionId: s.sessionId,
  state: 'running',
  title: s.goal,
  type: 'subagent'
})

const todoToItem = (t: TodoItem): ComposerStatusItem => ({
  id: `todo:${t.id}`,
  state: t.status === 'in_progress' ? 'running' : 'done',
  title: t.content,
  todoStatus: t.status,
  type: 'todo'
})

// Sessions whose goal judge (and, on DONE, verifier) is mid-flight. The
// gateway emits message.complete BEFORE running them, so without this the app
// looks idle through one or two auxiliary LLM round-trips. Cleared as soon as
// the verdict lands and refreshes the authoritative goal row.
export const $goalJudgingBySession = atom<Record<string, boolean>>({})

const goalToItem = (goal: GatewayGoalStatus, judging = false): ComposerStatusItem => {
  const progress = `${goal.turns_used}/${goal.max_turns}`
  // blocked/paused reasons are the user's call to action — they get the full
  // wrapped block. waiting/last_reason are ambient progress chatter and stay
  // inline where truncation is harmless.
  const note = goal.blocked_reason || goal.paused_reason
  const inline = judging ? 'judging…' : note ? undefined : goal.waiting_reason || goal.last_reason

  return {
    detail: inline ? `${progress} · ${inline}` : progress,
    detailNote: judging ? undefined : note || undefined,
    goalStatus: goal.status,
    id: 'goal:standing',
    // While judging, the row spins regardless of the last persisted status:
    // the turn is done but the goal has not decided yet.
    state: judging || goal.status === 'active' ? 'running' : goal.status === 'blocked' ? 'failed' : 'done',
    title: goal.goal,
    type: 'goal'
  }
}

// Fallback for sessions the authoritative `goal.status` RPC hasn't answered for
// yet: the text-derived store parsed off the gateway's status line.
const sessionGoalToItem = (goal: SessionGoal): ComposerStatusItem => ({
  detail: goal.detail,
  goalStatus: goal.status,
  id: 'goal:standing',
  state: goal.status === 'active' || goal.status === 'waiting' ? 'running' : 'done',
  title: goal.title,
  type: 'goal'
})

// The single thing the stack reads: a typed, merged item list per session.
//
// Identity contract: this computed's inputs churn constantly during a turn (a
// subagent tick, a 5s background poll, a todo update — in ANY session), but
// the merged output for most sessions is unchanged. Rebuilding fresh arrays
// and item objects every time handed every mounted composer stack a new
// reference per recompute — cross-session churn × open tiles. Stabilize both
// levels: an unchanged session keeps its previous array (and item objects),
// and a fully-unchanged map keeps its previous reference so `computed` skips
// the notify entirely ("preserve reference identity on no-ops").
const sameStatusItem = (a: ComposerStatusItem, b: ComposerStatusItem) =>
  a.id === b.id &&
  a.type === b.type &&
  a.state === b.state &&
  a.title === b.title &&
  a.output === b.output &&
  a.exitCode === b.exitCode &&
  a.currentTool === b.currentTool &&
  a.detail === b.detail &&
  a.detailNote === b.detailNote &&
  a.goalStatus === b.goalStatus &&
  a.todoStatus === b.todoStatus &&
  a.sessionId === b.sessionId

const stabilizeItems = (prev: ComposerStatusItem[] | undefined, next: ComposerStatusItem[]): ComposerStatusItem[] => {
  if (!prev) {
    return next
  }

  const merged = next.map((item, i) => (prev[i] && sameStatusItem(prev[i], item) ? prev[i] : item))

  return merged.length === prev.length && merged.every((item, i) => item === prev[i]) ? prev : merged
}

let prevStatusItems: Record<string, ComposerStatusItem[]> = {}

export const $statusItemsBySession = computed(
  [
    $goalStatusBySession,
    $goalsBySession,
    $subagentsBySession,
    $backgroundStatusBySession,
    $todosBySession,
    $goalJudgingBySession
  ],
  (goals, sessionGoals, subs, background, todos, judging) => {
    const out: Record<string, ComposerStatusItem[]> = {}

    const push = (sid: string, items: ComposerStatusItem[]) => {
      if (items.length > 0) {
        out[sid] = out[sid] ? [...out[sid], ...items] : items
      }
    }

    for (const [sid, list] of Object.entries(todos)) {
      push(sid, list.map(todoToItem))
    }

    for (const [sid, goal] of Object.entries(goals)) {
      push(sid, [goalToItem(goal, Boolean(judging[sid]))])
    }

    // Only where the richer record hasn't landed — never two goal rows.
    for (const [sid, goal] of Object.entries(sessionGoals)) {
      if (!goals[sid]) {
        push(sid, [sessionGoalToItem(goal)])
      }
    }

    for (const [sid, list] of Object.entries(subs)) {
      push(sid, list.filter(s => s.status === 'running' || s.status === 'queued').map(subToItem))
    }

    for (const [sid, list] of Object.entries(background)) {
      push(sid, list)
    }

    let unchanged = Object.keys(prevStatusItems).length === Object.keys(out).length

    for (const sid of Object.keys(out)) {
      out[sid] = stabilizeItems(prevStatusItems[sid], out[sid]!)
      unchanged &&= out[sid] === prevStatusItems[sid]
    }

    return (prevStatusItems = unchanged ? prevStatusItems : out)
  }
)

// Fixed render order for the groups in the stack (top → bottom, above queue).
const TYPE_ORDER: readonly StatusItemType[] = ['goal', 'todo', 'subagent', 'background']

export interface StatusGroup {
  items: ComposerStatusItem[]
  type: StatusItemType
}

export function groupStatusItems(items: readonly ComposerStatusItem[]): StatusGroup[] {
  const byType = new Map<StatusItemType, ComposerStatusItem[]>()

  for (const item of items) {
    const list = byType.get(item.type)

    if (list) {
      list.push(item)
    } else {
      byType.set(item.type, [item])
    }
  }

  return TYPE_ORDER.filter(type => byType.has(type)).map(type => ({ items: byType.get(type)!, type }))
}

const writeBackground = (sid: string, items: ComposerStatusItem[]) => {
  const current = $backgroundStatusBySession.get()
  const next = { ...current }

  if (items.length > 0) {
    next[sid] = items
  } else {
    delete next[sid]
  }

  $backgroundStatusBySession.set(next)
}

// `tui_gateway` process.list entry (tools/process_registry.list_sessions + output_tail).
interface GatewayProcessEntry {
  command?: string
  exit_code?: number
  output_tail?: string
  session_id?: string
  status?: string
}

const toBackgroundItem = (proc: GatewayProcessEntry): ComposerStatusItem => {
  const exited = proc.status === 'exited'
  const exitCode = typeof proc.exit_code === 'number' ? proc.exit_code : undefined

  return {
    exitCode,
    id: proc.session_id ?? '',
    output: proc.output_tail || undefined,
    state: exited ? (exitCode ? 'failed' : 'done') : 'running',
    title: (proc.command ?? '').split('\n')[0]!.trim() || 'background process',
    type: 'background'
  }
}

const sameItem = (a: ComposerStatusItem, b: ComposerStatusItem) =>
  a.state === b.state && a.title === b.title && a.output === b.output && a.exitCode === b.exitCode

/**
 * Layout-stable sync of the registry snapshot into the store: existing rows
 * keep their position (status flips happen in place, never reorder), new
 * processes append, dismissed ids stay gone, and unchanged rows keep their
 * object identity so memoised rows skip re-rendering.
 */
export function reconcileBackgroundProcesses(sid: string, procs: GatewayProcessEntry[]) {
  const dismissed = dismissedBySession.get(sid)

  const fresh = new Map(
    procs
      .filter(proc => proc.session_id && !dismissed?.has(proc.session_id))
      .map(proc => [proc.session_id!, toBackgroundItem(proc)])
  )

  const prev = $backgroundStatusBySession.get()[sid] ?? []

  // running → exited since the last snapshot = a background process just finished.
  const prevState = new Map(prev.map(item => [item.id, item.state]))

  for (const [id, item] of fresh) {
    if (item.state !== 'running' && prevState.get(id) === 'running') {
      dispatchNativeNotification({
        body: item.title,
        kind: 'backgroundDone',
        sessionId: sid,
        title: translateNow(
          item.state === 'failed'
            ? 'notifications.native.backgroundFailedTitle'
            : 'notifications.native.backgroundDoneTitle'
        )
      })
    }
  }

  const kept = prev.flatMap(old => {
    const next = fresh.get(old.id)
    fresh.delete(old.id)

    return next ? [sameItem(old, next) ? old : next] : []
  })

  const next = [...kept, ...fresh.values()]

  // Dismissals only need remembering while the registry still reports the id.
  if (dismissed) {
    const reported = new Set(procs.map(proc => proc.session_id))

    for (const id of dismissed) {
      if (!reported.has(id)) {
        dismissed.delete(id)
      }
    }
  }

  // Arm the self-clear on every finished task (failures linger longer); cancel
  // it for anything running again or gone from the snapshot.
  const finishedDelay = new Map(
    next
      .filter(item => item.state !== 'running')
      .map(item => [item.id, item.state === 'failed' ? FAILURE_LINGER_MS : SUCCESS_LINGER_MS])
  )

  for (const [id, delay] of finishedDelay) {
    scheduleAutoDismiss(sid, id, delay)
  }

  for (const id of [...(autoClearTimers.get(sid)?.keys() ?? [])]) {
    if (!finishedDelay.has(id)) {
      cancelAutoDismiss(sid, id)
    }
  }

  if (next.length === prev.length && next.every((item, i) => item === prev[i])) {
    return
  }

  writeBackground(sid, next)
}

// Sessions whose goal judge (and, on DONE, verifier) is mid-flight. The
// gateway emits message.complete BEFORE running them, so without this the app
// looks idle through one or two auxiliary LLM round-trips. Cleared as soon as
// the verdict lands and refreshes the authoritative goal row.
// (The atom itself is declared above goalToItem, which reads it.)
export function setGoalJudging(sid: string, judging: boolean) {
  if (!sid) {
    return
  }

  const current = $goalJudgingBySession.get()

  if (Boolean(current[sid]) === judging) {
    return // preserve reference identity on a no-op
  }

  const next = { ...current }

  if (judging) {
    next[sid] = true
  } else {
    delete next[sid]
  }

  $goalJudgingBySession.set(next)
}

export function reconcileGoalStatus(sid: string, goal: GatewayGoalStatus | null) {
  if (!sid) {
    return
  }

  const current = $goalStatusBySession.get()
  const next = { ...current }

  // The verdict has landed: whatever the outcome, judging is over.
  setGoalJudging(sid, false)

  if (goal && goal.status !== 'cleared' && goal.status !== 'done') {
    next[sid] = goal
  } else {
    delete next[sid]
  }

  $goalStatusBySession.set(next)
}

/** Pull the session's persisted native Goal state from the gateway. */
export async function refreshGoalStatus(sid: string): Promise<void> {
  const gateway = $gateway.get()

  if (!sid || !gateway) {
    return
  }

  try {
    const result = await gateway.request<{ goal?: GatewayGoalStatus | null }>('goal.status', { session_id: sid })

    reconcileGoalStatus(sid, result?.goal ?? null)
  } catch {
    // Older gateways do not expose goal.status; leave any event-fed row intact.
  }
}

/** Session ids the gateway has told us are gone. A session-scoped RPC against a
 *  runtime the gateway no longer holds fails 4001 "session not found" — a
 *  TERMINAL condition, not the transient socket loss the catch below assumes.
 *
 *  The status stack re-polls `process.list` every 5s while a running row is on
 *  screen, so treating 4001 as transient meant re-sending the same dead id
 *  forever: one runtime id accumulated 18,614 gateway rejections in a single day
 *  (#94219 fallout). Latch the id here and skip it until something rebinds it. */
const goneSessions = new Set<string>()

/** Gateway JSON-RPC code for "session not found" (tui_gateway _sess_nowait). */
const GATEWAY_SESSION_NOT_FOUND_CODE = 4001

/** A gone session is unrecoverable for THIS runtime id; a timeout or transport
 *  blip is not. Only the former may stop the poll — misclassifying a transient
 *  failure would silently freeze the status stack on a healthy session.
 *
 *  Match the gateway's 4001 code when the error carries one (JsonRpcGatewayError
 *  from a structured RPC rejection) — a message substring alone could latch on
 *  an unrelated error class that merely mentions "session not found" (e.g. a
 *  wrapped tool/report string). The message fallback survives only for errors
 *  with no numeric code at all, where the frame's structure was lost. */
export function isSessionGoneForBackgroundPolling(error: unknown): boolean {
  if (error instanceof JsonRpcGatewayError && typeof error.code === 'number') {
    return error.code === GATEWAY_SESSION_NOT_FOUND_CODE
  }

  const message = error instanceof Error ? error.message : String(error ?? '')

  return /session not found/i.test(message)
}

/** Clear the gone-latch. Called with a session id when a fresh runtime binds to
 *  it (so polling resumes), or with no argument to reset everything (tests). */
export function resetBackgroundPollingGuard(sid?: string): void {
  if (sid) {
    goneSessions.delete(sid)

    return
  }

  goneSessions.clear()
}

/** Pull the session's live process snapshot from the gateway. */
export async function refreshBackgroundProcesses(sid: string): Promise<void> {
  const gateway = $gateway.get()

  if (!sid || !gateway || goneSessions.has(sid)) {
    return
  }

  try {
    const result = await gateway.request<{ processes?: GatewayProcessEntry[] }>('process.list', { session_id: sid })

    reconcileBackgroundProcesses(sid, result?.processes ?? [])
  } catch (error) {
    // A gone session never comes back under this runtime id: stop polling it,
    // or the 5s timer hammers the gateway with 4001s for the window's lifetime.
    if (isSessionGoneForBackgroundPolling(error)) {
      goneSessions.add(sid)

      return
    }

    // Transient socket loss — the next trigger (event or poll) retries.
  }
}

/** X on a finished row: drop it now and keep it dropped across refreshes. */
export function dismissBackgroundProcess(sid: string, id: string) {
  cancelAutoDismiss(sid, id)

  const dismissed = dismissedBySession.get(sid) ?? new Set<string>()
  dismissed.add(id)
  dismissedBySession.set(sid, dismissed)

  const list = $backgroundStatusBySession.get()[sid] ?? []

  writeBackground(
    sid,
    list.filter(item => item.id !== id)
  )
}

/** X on a running row: kill the process for real, THEN drop the row. Only drop
 *  on a confirmed kill — dismissing unconditionally (the old behavior) hid the
 *  row while the process lived on, stranding rogue tasks. On failure the row
 *  stays so the user can retry / see it didn't die. */
export async function stopBackgroundProcess(sid: string, id: string): Promise<void> {
  try {
    await $gateway.get()?.request('process.kill', { process_id: id, session_id: sid })
    dismissBackgroundProcess(sid, id)
  } catch (err) {
    notifyError(err, 'Could not stop the process')
  }
}

/**
 * Rewind cleanup: a restore/edit discards the turns that spawned these
 * processes, so they belong to an abandoned timeline. Kill the live ones and
 * drop every row. Ids are marked dismissed so an in-flight `process.list` poll
 * (kill is async) can't resurrect them; reconcile garbage-collects those once
 * the registry stops reporting them.
 */
export function resetSessionBackground(sid: string) {
  if (!sid) {
    return
  }

  cancelAllAutoDismiss(sid)

  const gateway = $gateway.get()
  const list = $backgroundStatusBySession.get()[sid] ?? []
  const dismissed = dismissedBySession.get(sid) ?? new Set<string>()

  for (const item of list) {
    dismissed.add(item.id)

    if (item.state === 'running') {
      void gateway?.request('process.kill', { process_id: item.id, session_id: sid }).catch(() => undefined)
    }
  }

  dismissedBySession.set(sid, dismissed)
  writeBackground(sid, [])
}
