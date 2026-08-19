/**
 * Whether a workbench gateway event belongs to the session on screen.
 *
 * The naive check — `event.session_id !== $activeSessionId.get()` — has a race
 * that cost a real user their first diagram. Observed live over CDP:
 * `workbench.visualize` returned revision 11 for session `7412d192` while
 * `$activeSessionId` still read `b5a8c435`. The event was dropped, the pane
 * never opened, and the user had to ask "can you show me the harness?" for a
 * drawing that already existed in the database.
 *
 * The active id is assigned asynchronously, so in a brand-new session the FIRST
 * `artifact.updated` can land before the renderer knows which session is
 * foreground. A null/empty active id is therefore *absence of knowledge*, not
 * evidence the event belongs to someone else — accept it, because a first
 * drawing has no competitor. Once an id IS known, a mismatch is a genuine
 * cross-session event (background session, second window) and must be dropped
 * so it cannot paint over the foreground.
 */
export function acceptWorkbenchEvent(
  eventSessionId: string | undefined,
  activeSessionId: null | string | undefined
): boolean {
  if (!eventSessionId) {
    return false
  }

  if (!activeSessionId) {
    return true
  }

  return eventSessionId === activeSessionId
}
