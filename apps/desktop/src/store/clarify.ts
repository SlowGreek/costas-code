import { atom, computed } from 'nanostores'

import { $activeSessionId } from './session'

export interface ClarifyRequest {
  requestId: string
  question: string
  choices: string[] | null
  sessionId: string | null
}

/**
 * Validate and normalize a choices array.
 *
 * Keeps non-blank, newline-free strings of length ≤ 200; drops everything else
 * and returns an empty array when nothing usable survives — the caller then
 * falls back to a free-text answer instead of dead buttons.
 */
export function normalizeChoices(choices: unknown): string[] {
  if (!Array.isArray(choices)) {
    return []
  }

  return choices.filter(
    (c): c is string => typeof c === 'string' && c.trim().length > 0 && c.length <= 200 && !c.includes('\n')
  )
}

/**
 * Structured warning for a clarify payload that arrived with choices but had
 * them all normalized away — keeps the remaining #69122 "no selectable choices"
 * triggers diagnosable in the field without dead constant fields.
 */
export function warnDroppedChoices(source: 'gateway' | 'tool_args', question: string, rawChoices: unknown): void {
  console.warn('[clarify] choices dropped after normalization', {
    choices_count: Array.isArray(rawChoices) ? rawChoices.length : 0,
    question_length: question.length,
    source
  })
}

// Pending clarify requests keyed by the runtime session id that raised them.
// Storing per-session (instead of one shared slot) lets a *background* session
// park its clarify request while the user is looking at a different chat, then
// resolve it once they switch over — without a second concurrent clarify
// clobbering the first. A request with no session id lands under the empty key.
const keyFor = (sessionId: string | null | undefined): string => sessionId ?? ''

export const $clarifyRequests = atom<Record<string, ClarifyRequest>>({})

// The clarify request for the currently-viewed session. The inline ClarifyTool
// only ever mounts inside the active session's transcript, so it reads this
// focus-scoped view rather than reaching into the whole map.
export const $clarifyRequest = computed(
  [$clarifyRequests, $activeSessionId],
  (requests, activeId) => requests[keyFor(activeId)] ?? null
)

/** The clarify request for one specific session — the tile counterpart of the
 *  active-session `$clarifyRequest` view (same map, fixed key). */
export const sessionClarifyRequest = (sessionId: string | null) =>
  computed($clarifyRequests, requests => requests[keyFor(sessionId)] ?? null)

export function setClarifyRequest(request: ClarifyRequest): void {
  $clarifyRequests.set({ ...$clarifyRequests.get(), [keyFor(request.sessionId)]: request })
}

/**
 * Drop a parked clarify. Returns whether anything was actually removed, so a
 * caller can avoid acting on a no-op — a stale `clarify.expire` for a request
 * that has already been superseded must not clear the sidebar's "needs input"
 * flag on a session that is still blocked.
 */
export function clearClarifyRequest(requestId?: string, sessionId?: string | null): boolean {
  const requests = $clarifyRequests.get()

  // Targeted clear when the caller knows the session (the common path from the
  // inline ClarifyTool answering its own request).
  if (sessionId !== undefined) {
    const key = keyFor(sessionId)
    const current = requests[key]

    if (!current || (requestId && current.requestId !== requestId)) {
      return false
    }

    const next = { ...requests }
    delete next[key]
    $clarifyRequests.set(next)

    return true
  }

  // Fallback with no session hint: drop every entry matching the request id
  // (or clear all when none is given).
  const next: Record<string, ClarifyRequest> = {}
  let changed = false

  for (const [key, value] of Object.entries(requests)) {
    if (requestId && value.requestId !== requestId) {
      next[key] = value
    } else {
      changed = true
    }
  }

  if (changed) {
    $clarifyRequests.set(next)
  }

  return changed
}

/**
 * Re-arm the blocking prompts a resumed/activated session is still waiting on.
 *
 * `clarify.request` is emitted exactly once, when the tool blocks. A window
 * that opens afterwards — a reopened chat, an app restart, a reconnect that
 * dropped the frame — never saw it, so there is no entry here and the inline
 * card can never become answerable: it renders the persisted question from the
 * tool-call args and then has nothing to respond WITH. The agent stays blocked
 * until `agent.clarify_timeout` elapses.
 *
 * `session.resume` / `session.activate` carry `pending_prompts`, so the
 * renderer restores the same state the live event would have produced.
 *
 * Only `clarify.request` is restored: it is the one blocking prompt whose UI is
 * an inline transcript row keyed off a store entry. Approvals, sudo and secret
 * prompts render as overlays owned by `store/prompts.ts` and are left alone
 * rather than speculatively wired. Lives here, beside the store it writes, so
 * the resume path doesn't import through a second module into this one.
 */
export function rearmPendingPrompts(
  sessionId: null | string,
  prompts: { event: string; payload: Record<string, unknown> }[] | undefined
): void {
  if (!prompts?.length) {
    return
  }

  for (const prompt of prompts) {
    if (prompt?.event !== 'clarify.request') {
      continue
    }

    const payload = prompt.payload ?? {}
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : ''
    const question = typeof payload.question === 'string' ? payload.question : ''

    // A card with no request id could not be answered, and one with no question
    // could not be read — an unanswerable card is worse than none.
    if (!requestId || !question) {
      continue
    }

    const rawChoices = payload.choices
    const choices = normalizeChoices(rawChoices)

    if (rawChoices != null && choices.length === 0) {
      warnDroppedChoices('gateway', question, rawChoices)
    }

    setClarifyRequest({
      choices: choices.length > 0 ? choices : null,
      question,
      requestId,
      sessionId
    })
  }
}
