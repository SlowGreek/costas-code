import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DecodeText } from './decode-text'

vi.mock('@/hooks/use-media-query', () => ({ prefersReducedMotion: () => false }))

describe('DecodeText idle lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('decodes once by default, then releases its timer and cursor', () => {
    render(<DecodeText cursor prefix={1} text="HERMES" />)

    expect(screen.getByText('H', { exact: false }).querySelector('[aria-hidden="true"]')).toBeTruthy()

    act(() => vi.advanceTimersByTime(2_000))

    const label = screen.getByText('HERMES')

    expect(label.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps animating only when looping is explicitly requested', () => {
    render(<DecodeText cursor loop prefix={4} text="CONNECTING" />)

    act(() => vi.advanceTimersByTime(2_000))

    expect(vi.getTimerCount()).toBeGreaterThan(0)
    expect(screen.getByText('CONN', { exact: false }).querySelector('[aria-hidden="true"]')).toBeTruthy()
  })
})
