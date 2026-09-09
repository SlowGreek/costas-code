import type { SessionOwnerScope } from './session-request-router'

/** Ownership of admitted runtimes, not a guess from a possibly copied stored id. */
export const runtimeSessionOwners = new Map<string, SessionOwnerScope>()

export function sessionOwnerScopeKey(owner: SessionOwnerScope): string {
  if (!owner) {
    return ''
  }

  if (typeof owner === 'string') {
    return JSON.stringify(['profile', owner.trim() || 'default'])
  }

  return JSON.stringify([
    'connection',
    owner.connectionId.trim(),
    owner.profile.trim() || 'default',
    owner.targetProfile?.trim() || owner.profile.trim() || 'default'
  ])
}

export function runtimeMatchesSessionOwner(runtimeId: string, owner: SessionOwnerScope): boolean {
  const known = runtimeSessionOwners.get(runtimeId)

  // Legacy caches without an admission record retain their existing behavior.
  return !known || !owner || sessionOwnerScopeKey(known) === sessionOwnerScopeKey(owner)
}

export function recordAdmittedSessionRuntime(owner: SessionOwnerScope, method: string, result: unknown): void {
  if (!owner || !['session.create', 'session.resume', 'session.activate'].includes(method)) {
    return
  }

  if (!result || typeof result !== 'object' || !('session_id' in result)) {
    return
  }

  const runtimeId = result.session_id

  if (typeof runtimeId === 'string' && runtimeId) {
    runtimeSessionOwners.set(runtimeId, owner)
  }
}
