export type SessionDotState = 'background' | 'error' | 'idle' | 'needs-input' | 'stalled' | 'unread' | 'working'

interface SessionRowState {
  hasBackground: boolean
  hasError: boolean
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
 *   working      it is running
 *   background   a detached process is alive while the turn is idle
 *   unread       it finished and you haven't looked
 *
 * needs-input outranks error: a blocked prompt is actionable right now, while
 * an error is already over.
 */
export function sessionDotState({
  hasBackground,
  hasError,
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
    return isStalled ? 'stalled' : 'working'
  }

  if (hasBackground) {
    return 'background'
  }

  return isUnread ? 'unread' : 'idle'
}

/** A quiet turn is still authoritatively running. Keep the unmistakable row
 * arc until the gateway reports completion; only a blocking prompt suppresses
 * it in favour of the needs-input treatment. */
export function sessionShowsRunningArc({
  isWorking,
  needsInput
}: Pick<SessionRowState, 'isWorking' | 'needsInput'>): boolean {
  return isWorking && !needsInput
}
