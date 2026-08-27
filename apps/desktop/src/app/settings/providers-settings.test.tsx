import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmHost } from '@/components/confirm-host'
import { $confirmRequest } from '@/store/confirm'
import type { EnvVarInfo, OAuthProvider } from '@/types/hermes'

const listOAuthProviders = vi.fn()
const disconnectOAuthProvider = vi.fn()
const getEnvVars = vi.fn()
const startManualProviderOAuth = vi.fn()
const startManualLocalEndpoint = vi.fn()
const onboarding = atom({ manual: false })

vi.mock('@/hermes', () => ({
  disconnectOAuthProvider: (providerId: string) => disconnectOAuthProvider(providerId),
  getEnvVars: () => getEnvVars(),
  listOAuthProviders: () => listOAuthProviders()
}))

vi.mock('@/store/onboarding', () => ({
  $desktopOnboarding: onboarding,
  startManualProviderOAuth: (providerId: string) => startManualProviderOAuth(providerId),
  startManualLocalEndpoint: (reason: null | string) => startManualLocalEndpoint(reason)
}))

function provider(id: string, loggedIn: boolean, patch: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    cli_command: `hermes auth add ${id}`,
    disconnectable: true,
    docs_url: '',
    flow: 'device_code',
    id,
    name: id === 'nous' ? 'Nous Portal' : id === 'copilot' ? 'GitHub Copilot' : 'MiniMax',
    status: {
      logged_in: loggedIn
    },
    ...patch
  }
}

// One `/api/env` row (an EnvVarInfo) for the API-keys view. Mirrors the
// `provider()` factory above: a valid base + per-test overrides, typed against
// the real response shape so it can't drift from EnvVarInfo.
function keyVar(patch: Partial<EnvVarInfo> = {}): EnvVarInfo {
  return {
    advanced: false,
    category: 'provider',
    description: '',
    is_password: true,
    is_set: false,
    provider: '',
    provider_label: '',
    redacted_value: null,
    tools: [],
    url: '',
    ...patch
  }
}

beforeEach(() => {
  onboarding.set({ manual: false })
  getEnvVars.mockResolvedValue({})
  disconnectOAuthProvider.mockResolvedValue({ ok: true, provider: 'copilot' })
  listOAuthProviders.mockResolvedValue({
    providers: [provider('copilot', true), provider('minimax-oauth', false)]
  })
})

afterEach(() => {
  cleanup()
  $confirmRequest.set(null)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

// Removal goes through confirm() from @/store/confirm, so the host has to be
// mounted for the prompt to render — same as in the real app shell.
async function renderProvidersSettings() {
  const { ProvidersSettings } = await import('./providers-settings')
  let result: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <>
        <ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="accounts" />
        <ConfirmHost />
      </>
    )
  })

  return result!
}

describe('ProvidersSettings', () => {
  it('does not inject non-Copilot providers into Catalyst settings', async () => {
    listOAuthProviders.mockResolvedValue({
      providers: [provider('copilot', false), provider('minimax-oauth', false)]
    })

    await renderProvidersSettings()

    expect(await screen.findByText('GitHub Copilot')).toBeTruthy()
    expect(screen.queryByText('MiniMax')).toBeNull()
    expect(screen.queryByText('Fireworks AI')).toBeNull()
    expect(screen.queryByText('OpenRouter')).toBeNull()
  })

  it('disconnects a connected provider account and refreshes the accounts list', async () => {
    await renderProvidersSettings()

    const remove = await screen.findByRole('button', { name: 'Remove GitHub Copilot' })
    await act(async () => {
      fireEvent.click(remove)
    })

    // Removal is confirmed first — nothing has been disconnected yet.
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(disconnectOAuthProvider).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    })

    await waitFor(() => expect(disconnectOAuthProvider).toHaveBeenCalledWith('copilot'))
    expect(listOAuthProviders).toHaveBeenCalledTimes(2)
  })

  it('leaves the account connected when the removal prompt is dismissed', async () => {
    await renderProvidersSettings()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Remove GitHub Copilot' }))
    })

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    })

    expect(disconnectOAuthProvider).not.toHaveBeenCalled()
  })

  it('keeps provider selection separate from account removal', async () => {
    await renderProvidersSettings()

    await act(async () => {
      fireEvent.click(await screen.findByText('GitHub Copilot'))
    })

    expect(startManualProviderOAuth).toHaveBeenCalledWith('copilot')
    expect(disconnectOAuthProvider).not.toHaveBeenCalled()
  })

  it('does not render backend-tagged non-Copilot provider keys', async () => {
    getEnvVars.mockResolvedValue({
      WIDGETAI_API_KEY: keyVar({
        provider: 'widgetai',
        provider_label: 'WidgetAI',
        url: 'https://widgetai.example/keys'
      })
    })
    listOAuthProviders.mockResolvedValue({ providers: [] })

    const { ProvidersSettings } = await import('./providers-settings')
    await act(async () => {
      render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)
    })

    await waitFor(() => expect(getEnvVars).toHaveBeenCalled())
    expect(screen.queryByText('WidgetAI')).toBeNull()
  })

  it('keeps only the Copilot token card and filters it via search', async () => {
    getEnvVars.mockResolvedValue({
      COPILOT_GITHUB_TOKEN: keyVar({ provider: 'copilot', provider_label: 'GitHub Copilot' }),
      ZEBRA_API_KEY: keyVar({ provider: 'zebra', provider_label: 'Zebra' })
    })
    listOAuthProviders.mockResolvedValue({ providers: [] })

    const { ProvidersSettings } = await import('./providers-settings')
    render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)

    expect(await screen.findByText('GitHub Copilot')).toBeTruthy()
    expect(screen.queryByText('Zebra')).toBeNull()

    const search = screen.getByPlaceholderText('Search providers…')
    await act(async () => {
      fireEvent.change(search, { target: { value: 'nonesuch-xyz' } })
    })
    expect(await screen.findByText('No providers match your search.')).toBeTruthy()
  })

  it('does not offer a Local / custom endpoint in the Catalyst API-keys tab', async () => {
    getEnvVars.mockResolvedValue({})
    listOAuthProviders.mockResolvedValue({ providers: [] })

    const { ProvidersSettings } = await import('./providers-settings')
    render(<ProvidersSettings onClose={vi.fn()} onViewChange={vi.fn()} view="keys" />)

    await waitFor(() => expect(getEnvVars).toHaveBeenCalled())
    expect(screen.queryByText('Local / custom endpoint')).toBeNull()
    expect(startManualLocalEndpoint).not.toHaveBeenCalled()
  })
})
