import { afterEach, expect, it, vi } from 'vitest'

import { createSessionRpcDispatcher } from '@/app/contrib/session-rpc-dispatcher'
import { createClientSessionState } from '@/lib/chat-runtime'
import { requestGatewayForAgent } from '@/store/gateway'
import type * as GatewayModule from '@/store/gateway'
import { requestForSessionProfile } from '@/store/session-request-router'
import { runtimeMatchesSessionOwner } from '@/store/session-runtime-owner'
import { $sessionTiles, clearAllSessionStates, publishSessionState } from '@/store/session-states'

vi.mock('@/store/gateway', async importOriginal => ({
  ...(await importOriginal<typeof GatewayModule>()),
  requestGatewayForAgent: vi.fn(async (_connection, profile, method) => ({
    session_id: 'runtime-original',
    profile,
    method
  }))
}))

afterEach(() => {
  clearAllSessionStates()
  $sessionTiles.set([])
  vi.clearAllMocks()
})

it('records resume ownership and routes later runtime RPCs to it despite copied stored ids', async () => {
  const owner = { connectionId: 'local', profile: 'default' }
  const other = { connectionId: 'local', profile: 'catalyst-voice' }
  const ambient = vi.fn(async () => ({}))
  await requestForSessionProfile(owner, ambient as never, 'session.resume', { session_id: 'shared-stored' })
  const state = createClientSessionState('shared-stored')
  publishSessionState('runtime-original', state)
  $sessionTiles.set([{ storedSessionId: 'shared-stored', ownerRoute: other }])

  const request = createSessionRpcDispatcher({
    ambientRequest: ambient as never,
    runtimeIdByStoredSessionIdRef: { current: new Map([['shared-stored', 'runtime-original']]) },
    selectedStoredSessionIdRef: { current: 'shared-stored' },
    sessionStateByRuntimeIdRef: { current: new Map([['runtime-original', state]]) }
  })

  await request('process.list', { session_id: 'runtime-original' })
  expect(requestGatewayForAgent).toHaveBeenLastCalledWith('local', 'default', 'process.list', {
    session_id: 'runtime-original'
  })
  expect(runtimeMatchesSessionOwner('runtime-original', owner)).toBe(true)
  expect(runtimeMatchesSessionOwner('runtime-original', other)).toBe(false)
  expect(ambient).not.toHaveBeenCalled()
})
