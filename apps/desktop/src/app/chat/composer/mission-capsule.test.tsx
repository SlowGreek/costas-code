import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MissionCapsule } from './mission-capsule'

afterEach(cleanup)

describe('MissionCapsule', () => {
  it('renders a labelled researching mission as a polite status', () => {
    render(<MissionCapsule label="launch options" state="researching" />)

    const status = screen.getByRole('status')

    expect(status.textContent).toBe('Researching launch options')
    expect(status.getAttribute('aria-live')).toBe('polite')
    expect(status.getAttribute('aria-atomic')).toBe('true')
  })

  it.each([
    ['ready', 'Evidence ready'],
    ['awaiting_boundary', 'Evidence ready'],
    ['resuming', 'Building launch options'],
    ['presenting', 'Building launch options'],
    ['complete', 'Complete'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled']
  ] as const)('renders %s as concise user-facing language', (state, expected) => {
    render(<MissionCapsule label="launch options" state={state} />)

    expect(screen.getByRole('status').textContent).toBe(expected)
  })

  it('uses a reduced-motion-safe pulse only while work is active', () => {
    const view = render(<MissionCapsule state="researching" />)
    const activeIndicator = view.container.querySelector('[aria-hidden="true"]')

    expect(activeIndicator?.className).toContain('animate-pulse')
    expect(activeIndicator?.className).toContain('motion-reduce:animate-none')

    view.rerender(<MissionCapsule state="ready" />)

    expect(view.container.querySelector('[aria-hidden="true"]')?.className).not.toContain('animate-pulse')
  })

  it('exposes supplied actions and hides cancellation outside cancellable states', () => {
    const onCancel = vi.fn()
    const onDetails = vi.fn()
    const view = render(<MissionCapsule onCancel={onCancel} onDetails={onDetails} state="ready" />)

    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel mission' }))

    expect(onDetails).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()

    view.rerender(<MissionCapsule onCancel={onCancel} onDetails={onDetails} state="complete" />)

    expect(screen.queryByRole('button', { name: 'Cancel mission' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Details' })).toBeTruthy()
  })
})
