// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import {
  $sourceUpdate,
  $updateOverlayOpen,
  dismissSourceUpdate
} from '@/store/updates'

import { UpdatesOverlay } from './updates-overlay'

const restartSource = vi.fn()
const hash = (character: string) => `sha256:${character.repeat(64)}`

function renderOverlay() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <UpdatesOverlay />
    </I18nProvider>
  )
}

beforeEach(() => {
  restartSource.mockResolvedValue({ ok: true })
  Object.defineProperty(window, 'hermesDesktop', {
    configurable: true,
    value: { updates: { restartSource } }
  })
  $sourceUpdate.set({
    schema: 'catalyst-source-update-ready/1',
    sourceRevision: hash('a'),
    aeGeneration: hash('b'),
    requiresRestart: true,
    error: null,
    restarting: false
  })
  $updateOverlayOpen.set(true)
})

afterEach(() => {
  cleanup()
  dismissSourceUpdate()
  vi.clearAllMocks()
})

describe('source update prompt', () => {
  it('keeps the current window active until Restart Catalyst is chosen', async () => {
    renderOverlay()

    expect(screen.getByText('Changes ready')).not.toBeNull()
    expect(screen.getByText(/this window stays active until you choose/i)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Restart Catalyst' }))

    await waitFor(() => expect(restartSource).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Restart requested' })).not.toBeNull()
  })

  it('dismisses the pending update without requesting restart', () => {
    renderOverlay()

    fireEvent.click(screen.getByRole('button', { name: 'Later' }))

    expect(restartSource).not.toHaveBeenCalled()
    expect($sourceUpdate.get()).toBeNull()
    expect($updateOverlayOpen.get()).toBe(false)
  })
})
