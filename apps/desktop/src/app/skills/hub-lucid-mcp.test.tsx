// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesModule from '@/hermes'
import type { McpCatalogEntry } from '@/types/hermes'

const installMcpCatalogEntry = vi.fn()

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<typeof HermesModule>()),
  installMcpCatalogEntry
}))

function Location() {
  return <output aria-label="location">{useLocation().pathname + useLocation().search}</output>
}

function entry(installed = false): McpCatalogEntry {
  return {
    name: 'lucid-quine',
    description: 'AgentExperiments LUCID — seven closed verbs.',
    source: 'https://github.com/microsoft/AgentExperiments',
    transport: 'stdio',
    auth_type: 'none',
    required_env: [],
    command: 'butler',
    args: ['--mcp-stdio'],
    url: null,
    install_url: null,
    install_ref: null,
    bootstrap: [],
    default_enabled: [
      'lucid.show',
      'lucid.get',
      'lucid.set',
      'lucid.morph',
      'lucid.dispatch',
      'lucid.steer',
      'lucid.cancel'
    ],
    post_install: '',
    needs_install: false,
    installed,
    enabled: installed
  }
}

async function renderCard(installed = false) {
  const { LucidMcpHubCard } = await import('./hub')

  return render(
    <MemoryRouter initialEntries={['/skills?tab=hub']}>
      <QueryClientProvider client={new QueryClient()}>
        <LucidMcpHubCard entry={entry(installed)} />
        <Location />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  installMcpCatalogEntry.mockReset()
  installMcpCatalogEntry.mockResolvedValue({ ok: true, name: 'lucid-quine' })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('first-class LUCID MCP Hub offering', () => {
  it('shows the canonical seven verbs and exact stdio command', async () => {
    await renderCard()
    expect(screen.getByText('LUCID MCP')).toBeTruthy()
    expect(screen.getByText('butler --mcp-stdio · local transport · QUINE-governed')).toBeTruthy()

    for (const verb of entry().default_enabled ?? []) {expect(screen.getByText(verb)).toBeTruthy()}
  })

  it('installs through MCP catalog and opens the MCP inspector', async () => {
    await renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Install MCP' }))
    await waitFor(() => expect(installMcpCatalogEntry).toHaveBeenCalledWith('lucid-quine'))
    await waitFor(() =>
      expect(screen.getByLabelText('location').textContent).toBe('/skills?tab=mcp&server=lucid-quine')
    )
  })

  it('opens an already installed server without reinstalling', async () => {
    await renderCard(true)
    fireEvent.click(screen.getByRole('button', { name: 'Open MCP' }))
    expect(installMcpCatalogEntry).not.toHaveBeenCalled()
    expect(screen.getByLabelText('location').textContent).toBe('/skills?tab=mcp&server=lucid-quine')
  })
})
