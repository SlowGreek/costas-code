import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { $desktopOnboarding, type DesktopOnboardingState, type OnboardingContext } from '@/store/onboarding'
import { makeOAuthProvider } from '@/test/oauth-provider'
import type { OAuthProvider } from '@/types/hermes'

import { Picker } from '.'

function setProviders(providers: OAuthProvider[]) {
  $desktopOnboarding.set({
    configured: false,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false
  } satisfies DesktopOnboardingState)
}

const ctx: OnboardingContext = { requestGateway: async () => undefined as never }

afterEach(() => {
  cleanup()

  try {
    window.localStorage.clear()
  } catch {
    // jsdom localStorage should always be present; ignore if not.
  }

  $desktopOnboarding.set({
    configured: null,
    flow: { status: 'idle' },
    mode: 'oauth',
    providers: null,
    reason: null,
    requested: false,
    firstRunSkipped: false,
    manual: false,
    localEndpoint: false
  })
})

describe('onboarding Picker', () => {
  it('does not inject non-Copilot providers into the Catalyst picker', () => {
    setProviders([
      makeOAuthProvider('copilot', 'GitHub Copilot'),
      makeOAuthProvider('anthropic', 'Anthropic Claude')
    ])
    render(<Picker ctx={ctx} />)

    expect(screen.getByText('GitHub Copilot')).toBeTruthy()
    expect(screen.queryByText('Anthropic API Key')).toBeNull()
    expect(screen.queryByText('Fireworks AI')).toBeNull()
    expect(screen.queryByText('OpenRouter')).toBeNull()
  })

  it('offers only the Copilot token in Catalyst API-key setup', () => {
    setProviders([makeOAuthProvider('copilot', 'GitHub Copilot')])
    render(<Picker ctx={ctx} />)

    fireEvent.click(screen.getByRole('button', { name: 'I have an API key' }))

    expect(screen.getByText('GitHub Copilot')).toBeTruthy()
    expect(screen.queryByText('Fireworks AI')).toBeNull()
    expect(screen.queryByText('OpenRouter')).toBeNull()
    expect(screen.queryByText('Local / custom endpoint')).toBeNull()
  })

  it('offers "choose later" on first run and persists the skip', () => {
    setProviders([makeOAuthProvider('nous', 'Nous Portal')])
    render(<Picker ctx={ctx} />)

    const skip = screen.getByRole('button', { name: "I'll choose a provider later" })

    fireEvent.click(skip)

    expect($desktopOnboarding.get().firstRunSkipped).toBe(true)
    expect(window.localStorage.getItem('hermes-onboarding-skipped-v1')).toBe('1')
  })

  it('hides "choose later" in manual (add-provider) mode', () => {
    setProviders([makeOAuthProvider('nous', 'Nous Portal')])
    $desktopOnboarding.set({ ...$desktopOnboarding.get(), manual: true })
    render(<Picker ctx={ctx} />)

    expect(screen.queryByRole('button', { name: "I'll choose a provider later" })).toBeNull()
  })
})
