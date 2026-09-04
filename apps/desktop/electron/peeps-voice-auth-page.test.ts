import assert from 'node:assert/strict'

import { InteractionRequiredAuthError } from '@azure/msal-browser'
import { test, vi } from 'vitest'

import { runPeepsVoiceAuthPage } from './peeps-voice-auth-page'

interface MockClient {
  acquireTokenRedirect: ReturnType<typeof vi.fn>
  acquireTokenSilent: ReturnType<typeof vi.fn>
  getAllAccounts: ReturnType<typeof vi.fn>
  handleRedirectPromise: ReturnType<typeof vi.fn>
  initialize: ReturnType<typeof vi.fn>
}

function flowScript() {
  return {
    textContent: JSON.stringify({
      authority: 'https://login.microsoftonline.com/organizations',
      clientId: 'client-id',
      redirectUri: 'https://localhost:8080/',
      scope: 'https://peeps.asgprototype.com/api/access-as-user',
      state: 'state-123'
    })
  }
}

function createMockClient(overrides: Partial<MockClient> = {}) {
  return {
    acquireTokenRedirect: vi.fn(async () => undefined),
    acquireTokenSilent: vi.fn(async () => ({ accessToken: 'silent-token' })),
    getAllAccounts: vi.fn(() => [{ id: 'account' }]),
    handleRedirectPromise: vi.fn(async () => null),
    initialize: vi.fn(async () => undefined),
    ...overrides
  }
}

test('posts redirect results and closes without trying a silent refresh', async () => {
  const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
  const closeWindow = vi.fn()
  const client = createMockClient({
    acquireTokenSilent: vi.fn(),
    handleRedirectPromise: vi.fn(async () => ({ accessToken: 'redirected' }))
  })

  await runPeepsVoiceAuthPage({
    closeWindow,
    createClient: () => client as never,
    document: { querySelector: () => flowScript() } as unknown as Document,
    fetch: fetchFn as never
  })

  const [requestUrl, requestInit] = ((fetchFn.mock.calls as unknown) as Array<
    [unknown, RequestInit | undefined]
  >)[0] ?? []

  assert.equal(client.acquireTokenSilent.mock.calls.length, 0)
  assert.equal(client.acquireTokenRedirect.mock.calls.length, 0)
  assert.equal(requestUrl, 'https://localhost:8080/')
  assert.match(String(requestInit?.body), /"token":"redirected"/)
  assert.equal(closeWindow.mock.calls.length, 1)
})

test('uses acquireTokenSilent before redirect and redirects only on InteractionRequiredAuthError', async () => {
  const closeWindow = vi.fn()
  const fetchFn = vi.fn(async () => new Response(null, { status: 204 }))
  const client = createMockClient()

  await runPeepsVoiceAuthPage({
    closeWindow,
    createClient: () => client as never,
    document: { querySelector: () => flowScript() } as unknown as Document,
    fetch: fetchFn as never
  })

  assert.equal(client.acquireTokenSilent.mock.calls.length, 1)
  assert.equal(client.acquireTokenRedirect.mock.calls.length, 0)
  assert.equal(closeWindow.mock.calls.length, 1)

  client.acquireTokenSilent.mockRejectedValueOnce(new InteractionRequiredAuthError('login_required'))
  fetchFn.mockClear()
  closeWindow.mockClear()

  await runPeepsVoiceAuthPage({
    closeWindow,
    createClient: () => client as never,
    document: { querySelector: () => flowScript() } as unknown as Document,
    fetch: fetchFn as never
  })

  const [redirectCall] = client.acquireTokenRedirect.mock.calls as Array<
    [{ scopes: string[]; state: string }]
  >
  const [redirectRequest] = redirectCall ?? []

  assert.equal(client.acquireTokenRedirect.mock.calls.length, 1)
  assert.deepEqual(redirectRequest, {
    scopes: ['https://peeps.asgprototype.com/api/access-as-user'],
    state: 'state-123'
  })
  assert.equal(fetchFn.mock.calls.length, 0)
  assert.equal(closeWindow.mock.calls.length, 0)
})

test('non-interaction errors fail closed by closing the window', async () => {
  const closeWindow = vi.fn()
  const fetchFn = vi.fn()
  const client = createMockClient({
    acquireTokenSilent: vi.fn(async () => {
      throw new Error('boom')
    })
  })

  await runPeepsVoiceAuthPage({
    closeWindow,
    createClient: () => client as never,
    document: { querySelector: () => flowScript() } as unknown as Document,
    fetch: fetchFn as never
  })

  assert.equal(client.acquireTokenRedirect.mock.calls.length, 0)
  assert.equal(fetchFn.mock.calls.length, 0)
  assert.equal(closeWindow.mock.calls.length, 1)
})
