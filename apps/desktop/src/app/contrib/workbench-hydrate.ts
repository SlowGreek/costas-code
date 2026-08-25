import {
  clearWorkbenchForSessionTransition,
  setWorkbenchArtifact,
  setWorkbenchDrawing,
  type WorkbenchArtifact
} from '@/store/workbench'

interface GatewayLike {
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>
}

interface HydratorOptions {
  getGateway: () => GatewayLike | null
  getSessionId: () => null | string
}

/**
 * Load the active session's workbench artifact into the store.
 *
 * Extracted from the controller's module side effects so the ordering rules
 * below are actually testable — they were not, and the untested race shipped.
 *
 * Two rules:
 *
 * 1. **Retry when the gateway appears.** On a cold start (and after any
 *    reconnect or profile swap) the session id is set BEFORE the socket is
 *    open. A session-only subscription therefore takes the `!gateway` early
 *    return exactly once and never retries, leaving the canvas empty for the
 *    whole session while the artifact sits in the database. The caller
 *    subscribes to both the session and the gateway; this function is safe to
 *    call repeatedly.
 * 2. **Never let a stale reply win.** Each call takes a token; a reply is
 *    discarded if a newer hydrate started or the active session moved on.
 */
export function createWorkbenchHydrator(options: HydratorOptions) {
  let token = 0
  let activeRuntimeSessionId: null | string = null

  return async function hydrate(runtimeSessionId: null | string): Promise<void> {
    const mine = ++token
    const sessionChanged = runtimeSessionId !== activeRuntimeSessionId
    activeRuntimeSessionId = runtimeSessionId

    if (sessionChanged) {
      clearWorkbenchForSessionTransition()
    } else {
      setWorkbenchArtifact(null)
      // A pending draw belongs to the session that started it.
      setWorkbenchDrawing(false)
    }

    const gateway = options.getGateway()

    if (!gateway || !runtimeSessionId) {
      return
    }

    try {
      const result = await gateway.request<{ artifacts?: WorkbenchArtifact[] }>(
        'artifact.list',
        { session_id: runtimeSessionId }
      )

      if (mine !== token || options.getSessionId() !== runtimeSessionId) {
        return
      }

      const current = result.artifacts?.find(item => item.artifact_id === 'map.main')

      if (current) {
        setWorkbenchArtifact(current)
      }
    } catch {
      // A failed hydrate leaves an empty canvas, not a broken app; the next
      // `artifact.updated` or reconnect will fill it in.
    }
  }
}
