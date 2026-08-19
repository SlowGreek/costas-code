import { describe, expect, it } from 'vitest'

import { acceptWorkbenchEvent } from './workbench-event-scope'

describe('acceptWorkbenchEvent', () => {
  it('accepts an event for the session that is already active', () => {
    expect(acceptWorkbenchEvent('sess-a', 'sess-a')).toBe(true)
  })

  it('rejects an event for a different, still-live session', () => {
    // Two windows / a background session must never paint over the foreground.
    expect(acceptWorkbenchEvent('sess-b', 'sess-a')).toBe(false)
  })

  it('accepts the FIRST drawing of a brand-new session whose id has not landed yet', () => {
    // The race, caught live over CDP: `workbench.visualize` returned rev 11 for
    // session 7412d192 while $activeSessionId still read b5a8c435, so the
    // filter dropped the event and the canvas never opened. The user then had
    // to ask "can you show me the harness?" for a diagram that already existed.
    //
    // A null active id means the renderer does not yet know which session is
    // foreground. Safe ONLY because there is nothing on screen yet: a first
    // drawing has no competitor to overwrite.
    expect(acceptWorkbenchEvent('sess-new', null, false)).toBe(true)
  })

  it('does NOT overwrite a drawing already on screen when the active id is unknown', () => {
    // The opposite failure, hit by a real user the same day: a new session
    // drew a workout diagram while the canvas kept showing a previous
    // session's architecture map. Absence of knowledge about the foreground is
    // not a licence to paint over whatever is currently displayed.
    expect(acceptWorkbenchEvent('sess-other', null, true)).toBe(false)
  })

  it('rejects an event with no session id at all', () => {
    // Without an owner we cannot prove it is ours; dropping is the safe side.
    expect(acceptWorkbenchEvent(undefined, 'sess-a')).toBe(false)
    expect(acceptWorkbenchEvent('', 'sess-a')).toBe(false)
  })
})
