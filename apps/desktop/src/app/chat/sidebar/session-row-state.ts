export type SessionDotState =
  | 'background'
  | 'error'
  | 'idle'
  | 'needs-input'
  | 'stalled'
  | 'subagent'
  | 'unread'
  | 'working'

interface SessionRowState {
  hasBackground: boolean
  hasError: boolean
  hasSubagents: boolean
  isStalled: boolean
  isUnread: boolean
  isWorking: boolean
  needsInput: boolean
}

/** Resolve the sidebar dot's mutually-exclusive display state by priority.
 *
 * Priority reflects urgency, because only one colour can show:
 *   needs-input  you are blocking the turn — nothing moves until you act
 *   error        it stopped and you probably don't know
 *   subagent     the turn is running, and it is waiting on delegated work
 *   working      it is running
 *   background   a detached process is alive while the turn is idle
 *   unread       it finished and you haven't looked
 *
 * needs-input outranks error: a blocked prompt is actionable right now, while
 * an error is already over.
 *
 * `subagent` outranks plain `working` because it is strictly more specific —
 * both mean "running", but only one tells you the wait is fan-out rather than
 * the model thinking. It sits ABOVE working for that reason and BELOW error so
 * a failure is never masked by delegated work still in flight.
 */
export function sessionDotState({
  hasBackground,
  hasError,
  hasSubagents,
  isStalled,
  isUnread,
  isWorking,
  needsInput
}: SessionRowState): SessionDotState {
  if (needsInput) {
    return 'needs-input'
  }

  if (hasError) {
    return 'error'
  }

  if (isWorking) {
    if (hasSubagents) {
      return 'subagent'
    }

    return isStalled ? 'stalled' : 'working'
  }

  if (hasBackground) {
    return 'background'
  }

  return isUnread ? 'unread' : 'idle'
}

/** A quiet turn is still authoritatively running. Keep the unmistakable row
 * arc until the gateway reports completion; only a blocking prompt or a failed
 * turn suppresses it.
 *
 * Deliberately mirrors `sessionDotState`: the dot and the arc read the same
 * signals, so a row can never show a working dot with no arc (or an arc
 * shimmering under a red error dot). `isStalled` is intentionally NOT consulted
 * — a stalled turn is still running, and dropping the arc for it is what made
 * the shimmer look intermittent during long tool calls.
 */
export function sessionShowsRunningArc({
  hasError = false,
  isWorking,
  needsInput
}: Partial<Pick<SessionRowState, 'hasError'>> & Pick<SessionRowState, 'isWorking' | 'needsInput'>): boolean {
  return isWorking && !needsInput && !hasError
}
