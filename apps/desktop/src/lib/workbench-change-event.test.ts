import { describe, expect, it } from 'vitest'

import { describeWorkbenchChange } from './workbench-change-event'

/**
 * Snapshots tell the model what IS; events tell it what CHANGED.
 *
 * Rewriting the whole system prompt on every canvas change (the previous
 * design) has two costs: it invalidates prompt caching, and it only ever gives
 * the model state — so it can see twelve nodes but never "a node called Memory
 * just appeared", which is the thing worth speaking about.
 */
const map = (nodes: string[], edges: [string, string][] = []) => ({
  artifact_id: 'map.main',
  kind: 'map',
  payload: {
    nodes: nodes.map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
    edges: edges.map(([from, to]) => ({ id: `${from}-${to}`, from, to }))
  },
  semantic_rev: 1,
  view_rev: 1,
  view_state: {}
})

const change = (before: null | ReturnType<typeof map>, after: object) =>
  describeWorkbenchChange(before as never, after as never)

describe('describeWorkbenchChange', () => {
  it('reports a node that appeared', () => {
    const event = change(map(['voice']), map(['voice', 'memory']))

    expect(event).toMatch(/added/i)
    expect(event).toMatch(/Memory/)
  })

  it('reports a node that disappeared', () => {
    const event = change(map(['voice', 'memory']), map(['voice']))

    expect(event).toMatch(/removed/i)
    expect(event).toMatch(/Memory/)
  })

  it('reports a rename by id, not as an add plus a remove', () => {
    const before = map(['voice'])

    const after = {
      ...before,
      payload: { nodes: [{ id: 'voice', label: 'Realtime Voice' }], edges: [] }
    }

    const event = change(before, after)

    expect(event).toMatch(/renamed/i)
    expect(event).toMatch(/Realtime Voice/)
  })

  it('reports new connections in plain language', () => {
    const event = change(
      map(['voice', 'memory']),
      map(['voice', 'memory'], [['voice', 'memory']])
    )

    expect(event).toMatch(/connected/i)
    expect(event).toMatch(/Voice/)
    expect(event).toMatch(/Memory/)
  })

  it('reports a change of form, which is the biggest visual jump', () => {
    const timeline = { kind: 'timeline', payload: { items: [] }, semantic_rev: 2 }

    const event = change(map(['voice']), timeline)

    expect(event).toMatch(/timeline/i)
  })

  it('says nothing when nothing changed', () => {
    // An event per no-op would train the model to ignore the channel.
    expect(change(map(['voice']), map(['voice']))).toBeNull()
  })

  it('says nothing when only positions moved', () => {
    // Layout is the renderer's business. The model narrating a drag would be
    // noise, and it happens on every frame of one.
    const before = map(['voice'])
    const after = { ...before, semantic_rev: 2 }

    expect(change(before, after)).toBeNull()
  })

  it('summarises a wholesale redraw instead of listing every node', () => {
    // A full rethink can change everything. Listing 20 adds and 18 removes is
    // unspeakable; the model needs the shape of the change, not an inventory.
    const before = map(['a', 'b', 'c'])
    const after = map(['w', 'x', 'y', 'z'])

    const event = change(before, after)

    expect(event).toMatch(/redrew|redrawn|rebuilt/i)
    expect(event?.length ?? 0).toBeLessThan(200)
  })

  it('describes the first drawing as a first drawing', () => {
    const event = change(null, map(['voice', 'memory']))

    expect(event).toMatch(/drew|first/i)
  })

  it('stays short enough to speak', () => {
    const event = change(
      map(['voice']),
      map(['voice', 'memory', 'retrieval'], [['voice', 'memory']])
    )

    expect(event?.length ?? 0).toBeLessThan(200)
  })
})
