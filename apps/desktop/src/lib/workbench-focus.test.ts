import { describe, expect, it } from 'vitest'

import { focusedNodeId } from './workbench-focus'

describe('focusedNodeId', () => {
  it('reads the node the voice model is talking about', () => {
    // `workbench.focus` writes view_state.focus. Until this existed, NOTHING
    // read it: the tool succeeded, bumped view_rev, and the canvas showed no
    // sign of it — so the model could say "the planner here" and the user had
    // no idea which box it meant.
    expect(focusedNodeId({ focus: 'planner' })).toBe('planner')
  })

  it('is null when nothing is focused', () => {
    expect(focusedNodeId({})).toBeNull()
    expect(focusedNodeId(undefined)).toBeNull()
  })

  it('ignores a non-string focus rather than rendering garbage', () => {
    expect(focusedNodeId({ focus: 42 } as never)).toBeNull()
    expect(focusedNodeId({ focus: '' })).toBeNull()
    expect(focusedNodeId({ focus: '   ' })).toBeNull()
  })

  it('does not confuse focus with the user click selection', () => {
    // Two different referents that must stay distinct: `focus` is what the
    // ASSISTANT is pointing at, selection is what the USER clicked. Conflating
    // them would make the model appear to move the user's cursor.
    const viewState = { focus: 'planner', positions: { planner: { x: 1, y: 2 } } }

    expect(focusedNodeId(viewState)).toBe('planner')
    expect('selection' in viewState).toBe(false)
  })
})
