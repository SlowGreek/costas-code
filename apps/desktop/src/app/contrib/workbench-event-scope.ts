/**
 * Whether a workbench gateway event belongs to the session on screen.
 *
 * Two failure modes, pulling in opposite directions, and both were hit by a
 * real user on the same day:
 *
 * 1. **Too strict.** Comparing only with the primary runtime dropped a
 *    brand-new session's FIRST drawing, because the active id is assigned
 *    asynchronously and had not landed yet. Observed live: visualize returned
 *    revision 11 for `7412d192` while the atom still read `b5a8c435`. The
 *    canvas never opened and the user asked for a diagram that already
 *    existed.
 *
 * 2. **Too loose.** Accepting ANY event whenever the focused id is momentarily
 *    null let a background session paint over the foreground. Observed live:
 *    a new session drew a workout diagram, and the canvas kept showing a
 *    previous session's architecture map.
 *
 * The resolution is that a null focused id only excuses an event when there is
 * nothing on screen to protect. A first drawing has no competitor, so accept
 * it. Once an artifact IS displayed, the event must name the session we are
 * showing — absence of knowledge is no longer a licence to overwrite.
 */
export function acceptWorkbenchEvent(
  eventSessionId: string | undefined,
  focusedSessionId: null | string | undefined,
  hasArtifactOnScreen = false
): boolean {
  if (!eventSessionId) {
    return false
  }

  if (focusedSessionId) {
    return eventSessionId === focusedSessionId
  }

  // Focused id unknown: safe only while the canvas is empty.
  return !hasArtifactOnScreen
}
