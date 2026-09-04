import { InteractionRequiredAuthError, PublicClientApplication } from '@azure/msal-browser'

interface Flow {
  authority: string
  clientId: string
  redirectUri: string
  scope: string
  state: string
}

interface PageEnv {
  closeWindow: () => void
  createClient: (flow: Flow) => Pick<
    PublicClientApplication,
    'acquireTokenRedirect' | 'acquireTokenSilent' | 'getAllAccounts' | 'handleRedirectPromise' | 'initialize'
  >
  document: Document
  fetch: typeof fetch
}

function readFlow(document: Document): Flow {
  return JSON.parse(document.querySelector<HTMLScriptElement>('#peeps-flow')?.textContent || '{}') as Flow
}

async function postToken(env: Pick<PageEnv, 'closeWindow' | 'fetch'>, flow: Flow, token: string) {
  await env.fetch(flow.redirectUri, {
    body: JSON.stringify({ state: flow.state, token }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST'
  })
  env.closeWindow()
}

export async function runPeepsVoiceAuthPage(env: PageEnv): Promise<void> {
  const flow = readFlow(env.document)
  const client = env.createClient(flow)

  try {
    await client.initialize()
    const redirected = await client.handleRedirectPromise()
    if (redirected?.accessToken) {
      await postToken(env, flow, redirected.accessToken)
      return
    }

    const account = client.getAllAccounts()[0]
    if (!account) {
      throw new InteractionRequiredAuthError('login_required')
    }

    try {
      const silent = await client.acquireTokenSilent({ account, scopes: [flow.scope] })
      await postToken(env, flow, silent.accessToken)
      return
    } catch (error) {
      if (!(error instanceof InteractionRequiredAuthError)) {
        throw error
      }
    }

    await client.acquireTokenRedirect({ scopes: [flow.scope], state: flow.state })
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      await client.acquireTokenRedirect({ scopes: [flow.scope], state: flow.state })
      return
    }
    env.closeWindow()
  }
}

export function defaultPeepsVoiceAuthPageEnv(): PageEnv {
  return {
    closeWindow: () => window.close(),
    createClient: flow =>
      new PublicClientApplication({
        auth: {
          authority: flow.authority,
          clientId: flow.clientId,
          redirectUri: flow.redirectUri
        }
      }),
    document,
    fetch
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void runPeepsVoiceAuthPage(defaultPeepsVoiceAuthPageEnv())
}
