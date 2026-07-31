import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { UguiDocumentPainter } from './document-painter'

const document = () => ({
  id: 'settings.document',
  type: 'document',
  header: [{ id: 'heading', type: 'text', body: 'Settings', style: 'heading' }],
  sections: [
    {
      id: 'status',
      type: 'status_grid',
      items: [{ label: 'Backend', value: 'Ready', status: 'ok' }]
    }
  ],
  actions: [{ id: 'apply', type: 'button', label: 'Apply', action: 'settings.apply' }]
})

describe('UGUI Document painter', () => {
  it('paints semantic regions without a Scene projection', () => {
    const { container } = render(<UguiDocumentPainter document={document()} />)

    expect(screen.getByText('Settings')).not.toBeNull()
    expect(screen.getByText('Backend')).not.toBeNull()
    expect(screen.getByText('Ready')).not.toBeNull()
    expect(container.querySelector('[data-ugui-document-id="settings.document"]')).not.toBeNull()
    expect(container.querySelector('[data-ugui-node-id]')).toBeNull()
  })

  it('dispatches a bounded Document event from an action item', () => {
    const onEvent = vi.fn()
    render(<UguiDocumentPainter document={document()} onEvent={onEvent} />)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onEvent).toHaveBeenCalledWith({
      schema: 'ugui-document-event/1',
      document_id: 'settings.document',
      item_id: 'apply',
      gesture: 'tap',
      action: 'settings.apply',
      payload: null
    })
  })
})
