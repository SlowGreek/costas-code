import {
  BrowserCacheLocation,
  InteractionRequiredAuthError,
  PublicClientApplication
} from '@azure/msal-browser'

interface Flow {
  authSessionId: string
  authority: string
  clientId: string
  publicKey: string
  redirectUri: string
  scope: string
  state: string
}

interface PageEnv {
  clearSessionState?: () => void
  closeWindow: () => void
  createClient: (flow: Flow) => Pick<
    PublicClientApplication,
    | 'acquireTokenRedirect'
    | 'acquireTokenSilent'
    | 'clearCache'
    | 'getAllAccounts'
    | 'handleRedirectPromise'
    | 'initialize'
  >
  document: Document
  fetch: typeof fetch
}

function readFlow(document: Document): Flow {
  return JSON.parse(document.querySelector<HTMLScriptElement>('#peeps-flow')?.textContent || '{}') as Flow
}

async function postToken(env: PageEnv, client: Pick<PublicClientApplication, 'clearCache'>, flow: Flow, token: string) {
  try {
    await env.fetch(flow.redirectUri, {
      body: JSON.stringify({ state: flow.state, token }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })
  } finally {
    token = ''
    await client.clearCache().catch(() => undefined)
    env.clearSessionState?.()
  }

  env.closeWindow()
}

export function createPeepsVoiceAuthClient(flow: Flow): PublicClientApplication {
  return new PublicClientApplication(buildPeepsVoiceAuthClientConfig(flow))
}

export function buildPeepsVoiceAuthClientConfig(flow: Flow) {
  return {
    auth: {
      authority: flow.authority,
      clientId: flow.clientId,
      redirectUri: flow.redirectUri,
      navigateToLoginRequestUrl: false
    },
    cache: {
      cacheLocation: BrowserCacheLocation.MemoryStorage,
      temporaryCacheLocation: BrowserCacheLocation.SessionStorage
    }
  }
}

export async function runPeepsVoiceAuthPage(env: PageEnv): Promise<void> {
  const flow = readFlow(env.document)
  const client = env.createClient(flow)

  try {
    await client.initialize()
    const redirected = await client.handleRedirectPromise()

    if (redirected?.accessToken) {
      if (redirected.state !== flow.state) {
        throw new Error('Peeps redirect state mismatch')
      }

      await postToken(env, client, flow, redirected.accessToken)

      return
    }

    const account = client.getAllAccounts()[0]

    if (account) {
      try {
        const silent = await client.acquireTokenSilent({ account, scopes: [flow.scope] })
        await postToken(env, client, flow, silent.accessToken)

        return
      } catch (error) {
        if (!(error instanceof InteractionRequiredAuthError)) {throw error}
      }
    }

    await client.acquireTokenRedirect({ scopes: [flow.scope], state: flow.state })
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      await client.acquireTokenRedirect({ scopes: [flow.scope], state: flow.state })

      return
    }

    await client.clearCache().catch(() => undefined)
    env.clearSessionState?.()
    env.closeWindow()
  }
}

export function defaultPeepsVoiceAuthPageEnv(): PageEnv {
  return {
    clearSessionState: () => sessionStorage.clear(),
    closeWindow: () => window.close(),
    createClient: createPeepsVoiceAuthClient,
    document,
    fetch
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void runPeepsVoiceAuthPage(defaultPeepsVoiceAuthPageEnv())
}
