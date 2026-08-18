import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { QuadrantRenderer } from './quadrant-renderer'

const axes = {
  x: { high: 'expensive', low: 'cheap' },
  y: { high: 'high impact', low: 'low impact' }
}

const artifact = (payload: unknown) => ({ payload, semantic_rev: 1 })

describe('QuadrantRenderer', () => {
  afterEach(cleanup)

  it('renders both axis label pairs', () => {
    render(
      <QuadrantRenderer artifact={artifact({ axes, items: [{ id: 'a', label: 'A', x: 0.5, y: 0.5 }] })} />
    )

    for (const label of ['cheap', 'expensive', 'low impact', 'high impact']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
  })

  it('maps semantic 0..1 coordinates to percentage geometry with y inverted', () => {
    render(
      <QuadrantRenderer
        artifact={artifact({
          axes,
          items: [
            { id: 'top-left', label: 'Top left', x: 0, y: 1 },
            { id: 'bottom-right', label: 'Bottom right', x: 1, y: 0 }
          ]
        })}
      />
    )

    const [topLeft, bottomRight] = screen.getAllByTestId('quadrant-item') as HTMLElement[]

    expect(topLeft.style.left).toBe('0%')
    expect(topLeft.style.top).toBe('0%')
    expect(bottomRight.style.left).toBe('100%')
    expect(bottomRight.style.top).toBe('100%')
  })

  it('drops items with out-of-range or non-numeric coordinates', () => {
    render(
      <QuadrantRenderer
        artifact={artifact({
          axes,
          items: [
            { id: 'ok', label: 'Keep', x: 0.4, y: 0.6 },
            { id: 'high', label: 'Too high', x: 1.4, y: 0.5 },
            { id: 'neg', label: 'Negative', x: -0.2, y: 0.5 },
            { id: 'str', label: 'String', x: '0.5', y: 0.5 },
            { id: 'missing', label: 'Missing y', x: 0.5 }
          ]
        })}
      />
    )

    const items = screen.getAllByTestId('quadrant-item')

    expect(items).toHaveLength(1)
    expect(items[0].textContent).toContain('Keep')
  })

  it('falls back to generic axis labels when axes are absent', () => {
    render(<QuadrantRenderer artifact={artifact({ items: [{ id: 'a', label: 'A', x: 0.5, y: 0.5 }] })} />)

    expect(screen.getAllByText('low')).toHaveLength(2)
    expect(screen.getAllByText('high')).toHaveLength(2)
  })

  it('renders an empty state when nothing is plottable', () => {
    render(<QuadrantRenderer artifact={artifact({ axes, items: [] })} />)

    expect(screen.getByTestId('quadrant-empty')).toBeTruthy()
  })
})
