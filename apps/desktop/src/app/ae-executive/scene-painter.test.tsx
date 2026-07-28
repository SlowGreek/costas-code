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

  it('renders producer-declared selection and emits one revision-bound selection intent', () => {
    const events: UguiSceneEvent[] = []

    const designer: AeExecutiveScene = {
      ...scene,
      receipt: {
        revision: 9,
        editor: {
          selectable_node_ids: ['button'],
          selected_node_id: 'button'
        }
      }
    }

    const view = render(<AeScenePainter onEvent={event => events.push(event)} scene={designer} />)
    const selectable = screen.getByRole('option', { name: 'Select Apply button' })
    const root = view.container.querySelector<HTMLElement>('[data-scene-root]')!

    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      x: 10, y: 20, left: 10, top: 20, right: 410, bottom: 320, width: 400, height: 300,
      toJSON: () => ({})
    })
    vi.spyOn(selectable, 'getBoundingClientRect').mockReturnValue({
      x: 30, y: 60, left: 30, top: 60, right: 130, bottom: 90, width: 100, height: 30,
      toJSON: () => ({})
    })

    fireEvent(window, new Event('resize'))
    fireEvent.click(selectable)

    expect(view.container.querySelector('[data-ugui-selection-overlay="button"]')).toBeTruthy()
    expect(events).toEqual([{
      schema: 'ugui-scene-event/1',
      scene_id: 'typed-events',
      revision: 9,
      node_id: 'button',
      gesture: 'focus',
      action: 'studio.element.select',
      payload: { value: 'button' }
    }])
  })

  it('does not add selection wrappers when the producer declares no editor metadata', () => {
    const view = render(<AeScenePainter scene={scene} />)

    expect(view.container.querySelector('[role="option"]')).toBeNull()
    expect(view.container.querySelector('[data-ugui-selection-overlay]')).toBeNull()
  })

  it('preserves the legacy action adapter during migration', () => {
    const onAction = vi.fn()
    render(<AeScenePainter onAction={onAction} scene={scene} />)
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onAction).toHaveBeenCalledWith('skin.apply')
  })
})
