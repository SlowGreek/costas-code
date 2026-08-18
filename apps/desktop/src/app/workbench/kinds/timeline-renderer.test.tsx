import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { TimelineRenderer } from './timeline-renderer'

const artifact = (payload: unknown) => ({ payload, semantic_rev: 1 })

describe('TimelineRenderer', () => {
  afterEach(cleanup)

  it('renders items sorted by the semantic order key, not payload order', () => {
    render(
      <TimelineRenderer
        artifact={artifact({
          items: [
            { id: 'c', label: 'Ship', order: 2 },
            { id: 'a', label: 'Discover', order: 0 },
            { id: 'b', label: 'Prototype', order: 1 }
          ]
        })}
      />
    )

    const labels = screen.getAllByTestId('timeline-item').map(node => node.textContent)

    expect(labels[0]).toContain('Discover')
    expect(labels[1]).toContain('Prototype')
    expect(labels[2]).toContain('Ship')
  })

  it('falls back to payload order when order is missing', () => {
    render(
      <TimelineRenderer
        artifact={artifact({ items: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }] })}
      />
    )

    const labels = screen.getAllByTestId('timeline-item').map(node => node.textContent)

    expect(labels[0]).toContain('First')
    expect(labels[1]).toContain('Second')
  })

  it('shows optional detail text', () => {
    render(
      <TimelineRenderer
        artifact={artifact({ items: [{ detail: 'talk to five users', id: 'a', label: 'Discover' }] })}
      />
    )

    expect(screen.getByText('talk to five users')).toBeTruthy()
  })

  it('skips malformed entries rather than crashing', () => {
    render(
      <TimelineRenderer
        artifact={artifact({ items: [null, 'nope', { id: 'a' }, { label: 'no id' }, { id: 'b', label: 'Real' }] })}
      />
    )

    expect(screen.getAllByTestId('timeline-item')).toHaveLength(1)
    expect(screen.getByTestId('timeline-canvas').textContent).toContain('Real')
  })

  it('renders an empty state for an empty or non-timeline payload', () => {
    const { rerender } = render(<TimelineRenderer artifact={artifact({ items: [] })} />)

    expect(screen.getByTestId('timeline-empty')).toBeTruthy()

    rerender(<TimelineRenderer artifact={artifact({ nodes: [], edges: [] })} />)

    expect(screen.getByTestId('timeline-empty')).toBeTruthy()
  })
})
