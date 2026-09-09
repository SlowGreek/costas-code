import { afterEach, expect, it, vi } from 'vitest'

import { createSessionRpcDispatcher } from '@/app/contrib/session-rpc-dispatcher'
import { resolveTargetSessionId } from '@/app/session/hooks/use-prompt-actions/resolve-target-session'
import {
  clearSingleFlightSessionResumeState,
  registerRecoveredRuntime
} from '@/app/session/hooks/use-prompt-actions/single-flight-resume'
import { requestGatewayForAgent } from '@/store/gateway'
import type * as GatewayModule from '@/store/gateway'
import { $sessions } from '@/store/session'
import { runtimeSessionOwners } from '@/store/session-runtime-owner'
import { $sessionTiles, clearAllSessionStates } from '@/store/session-states'

vi.mock('@/store/gateway', async original => ({
  ...(await original<typeof GatewayModule>()),
  requestGatewayForAgent: vi.fn(async (connection, profile) => ({ session_id: `runtime-${connection}-${profile}` }))
}))
afterEach(() => {
  clearAllSessionStates()
  $sessions.set([])
  $sessionTiles.set([])
  clearSingleFlightSessionResumeState()
  vi.clearAllMocks()
})

function resolveTarget() {
  const requestGateway = createSessionRpcDispatcher({
    ambientRequest: vi.fn() as never,
    runtimeIdByStoredSessionIdRef: { current: new Map() },
    selectedStoredSessionIdRef: { current: 'copied' },
    sessionStateByRuntimeIdRef: { current: new Map() }
  })

  return resolveTargetSessionId({
    activeRuntimeId: null,
    createSession: vi.fn(),
    getRuntimeIdForStoredSession: () => null,
    requestGateway,
    routedStoredSessionId: 'copied',
    selectedStoredSessionId: 'copied'
  })
}

it('captures the explicit tile owner rather than a copied sidebar row', async () => {
  $sessions.set([{ id: 'copied', connection_id: 'one', profile: 'default' }] as never)
  $sessionTiles.set([{ storedSessionId: 'copied', ownerRoute: { connectionId: 'two', profile: 'default' } }])
  await resolveTarget()
  expect(vi.mocked(requestGatewayForAgent).mock.calls.map(args => args.slice(0, 2))).toEqual([['two', 'default']])
})

it.each([false, true])('keeps backend profile identity across target recovery with cached=%s', async cached => {
  const owner = { connectionId: 'two', profile: 'alias', targetProfile: 'backend', mode: 'remote' as const }
  $sessions.set([{ id: 'copied', connection_id: 'two', profile: 'alias' }] as never)
  $sessionTiles.set([{ storedSessionId: 'copied', ownerRoute: owner }])

  if (cached) {
    runtimeSessionOwners.set('published', owner)
    registerRecoveredRuntime('copied', 'published', runtimeSessionOwners.get('published'))
    expect(await resolveTarget()).toBe('published')
    expect(requestGatewayForAgent).not.toHaveBeenCalled()
  } else {
    await resolveTarget()
    expect(vi.mocked(requestGatewayForAgent).mock.calls[0]?.[3]?.profile).toBe('backend')
  }
})
