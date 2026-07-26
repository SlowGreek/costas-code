// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { AeExecutiveScene } from './scene'
import { AeScenePainter, type UguiSceneEvent } from './scene-painter'

const scene: AeExecutiveScene = {
  sceneVersion: '1.0.0',
  id: 'typed-events',
  root: 'root',
  receipt: { revision: 7 },
  nodes: [
    { id: 'root', p: 'column', kids: ['button', 'input', 'select'] },
    { id: 'button', p: 'button', a: { label: 'Apply' }, on: { tap: 'skin.apply' } },
    { id: 'input', p: 'input', a: { name: 'Alias', value: 'old' }, on: { submit: 'alias.submit' } },
    {
      id: 'select',
      p: 'select',
      a: { name: 'Skin', value: 'glass', options: ['glass', 'windows-95'] },
      on: { change: 'skin.change' }
    }
  ]
}

describe('UGUI typed Scene events', () => {
  it('emits scene/revision/node/action and current control payloads', () => {
    const events: UguiSceneEvent[] = []
    render(<AeScenePainter onEvent={event => events.push(event)} scene={scene} />)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const input = screen.getByRole('textbox', { name: 'Alias' })
    fireEvent.change(input, { target: { value: 'current value' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(screen.getByRole('combobox', { name: 'Skin' }), { target: { value: 'windows-95' } })

    expect(events).toEqual([
      {
        schema: 'ugui-scene-event/1',
        scene_id: 'typed-events',
        revision: 7,
        node_id: 'button',
        gesture: 'tap',
        action: 'skin.apply',
        payload: null
      },
      {
        schema: 'ugui-scene-event/1',
        scene_id: 'typed-events',
        revision: 7,
        node_id: 'input',
        gesture: 'submit',
        action: 'alias.submit',
        payload: { value: 'current value' }
      },
      {
        schema: 'ugui-scene-event/1',
        scene_id: 'typed-events',
        revision: 7,
        node_id: 'select',
        gesture: 'change',
        action: 'skin.change',
        payload: { value: 'windows-95' }
      }
    ])
  })

  it('preserves the legacy action adapter during migration', () => {
    const onAction = vi.fn()
    render(<AeScenePainter onAction={onAction} scene={scene} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onAction).toHaveBeenCalledWith('skin.apply')
  })
})
