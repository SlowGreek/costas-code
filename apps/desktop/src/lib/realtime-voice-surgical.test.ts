import { describe, expect, it } from 'vitest'

import { surgicalToolRequest } from './realtime-voice'

describe('surgicalToolRequest', () => {
  it('routes go_back to the instant restore path, not a redraw', () => {
    // "Go back" must never cost a ~9s diagrammer call to recreate a drawing we
    // already have on disk.
    expect(surgicalToolRequest('go_back', '{}')).toEqual({
      method: 'workbench.back',
      params: {}
    })
  })

  it('accepts go_back with junk arguments', () => {
    // The model sometimes sends '' or malformed JSON for a no-arg tool; going
    // back must not silently fail because of it.
    expect(surgicalToolRequest('go_back', '')?.method).toBe('workbench.back')
    expect(surgicalToolRequest('go_back', 'not json')?.method).toBe('workbench.back')
  })

  it('routes rename to workbench.edit without touching the diagrammer', () => {
    expect(surgicalToolRequest('rename', '{"node_id":"a","label":"Planner"}')).toEqual({
      method: 'workbench.edit',
      params: { edit: { label: 'Planner', node_id: 'a', op: 'rename' } }
    })
  })

  it('routes add_node as one validated direct edit', () => {
    expect(
      surgicalToolRequest(
        'add_node',
        '{"id":"planner","label":"Planner","kind":"agent"}'
      )
    ).toEqual({
      method: 'workbench.edit',
      params: {
        edit: { id: 'planner', kind: 'agent', label: 'Planner', op: 'add_node' }
      }
    })
  })

  it('routes focus to a view-only RPC', () => {
    expect(surgicalToolRequest('focus', '{"node_id":"a"}')).toEqual({
      method: 'workbench.focus',
      params: { node_id: 'a' }
    })
  })

  it('omits an empty connect label rather than sending a blank one', () => {
    expect(surgicalToolRequest('connect', '{"from_id":"a","to_id":"b","label":"  "}')).toEqual({
      method: 'workbench.edit',
      params: { edit: { from_id: 'a', op: 'connect', to_id: 'b' } }
    })
  })

  it('routes disconnect and remove', () => {
    expect(surgicalToolRequest('disconnect', '{"edge_id":"e1"}')?.params).toEqual({
      edit: { edge_id: 'e1', op: 'disconnect' }
    })
    expect(surgicalToolRequest('remove', '{"node_id":"c"}')?.params).toEqual({
      edit: { node_id: 'c', op: 'remove' }
    })
  })

  it('returns null for missing arguments and unknown tools', () => {
    expect(surgicalToolRequest('rename', '{"node_id":"a"}')).toBeNull()
    expect(surgicalToolRequest('connect', '{"from_id":"a"}')).toBeNull()
    expect(surgicalToolRequest('remove', 'not json')).toBeNull()
    expect(surgicalToolRequest('visualize', '{}')).toBeNull()
    expect(surgicalToolRequest('session_snapshot', '{}')).toBeNull()
  })

  it('never routes a surgical tool through the diagrammer RPC', () => {
    for (const name of ['focus', 'add_node', 'rename', 'connect', 'disconnect', 'remove']) {
      const routed = surgicalToolRequest(
        name,
        '{"node_id":"a","label":"x","from_id":"a","to_id":"b","edge_id":"e1"}'
      )

      expect(routed?.method).not.toBe('workbench.visualize')
    }
  })
})
