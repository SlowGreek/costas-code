import { describe, expect, it } from 'vitest'

import { REALTIME_INSTRUCTIONS_FOR_TESTS } from './realtime-voice'

/**
 * Behaviour contracts for the voice instructions, not wording snapshots.
 *
 * Each assertion exists because its absence produced a real failure in a real
 * session, so a future edit that drops one should fail here rather than in
 * front of the user.
 */
describe('realtime instructions', () => {
  const text = REALTIME_INSTRUCTIONS_FOR_TESTS

  it('teaches deixis, so "this one" resolves instead of asking which', () => {
    expect(text).toMatch(/pointing_at/)
    expect(text).toMatch(/this one/i)
  })

  it('keeps the proactive-drawing behaviour', () => {
    expect(text).toMatch(/visualize/)
    expect(text).toMatch(/draw first/i)
  })

  it('explains that visualize returns before the drawing exists', () => {
    // Without this the model waits for a result that never comes, or announces
    // a picture that has not arrived. Both were observed.
    expect(text).toMatch(/status: drawing/)
  })

  it('steers single edits to the instant tools', () => {
    for (const tool of ['focus', 'rename', 'connect', 'disconnect', 'remove', 'go_back']) {
      expect(text, `${tool} missing from instructions`).toMatch(new RegExp(tool))
    }
  })

  it('asks for silent tool calls, which is what removes the audible seam', () => {
    // A function call ENDS the Realtime response, so anything said before it
    // becomes a separate utterance and the user hears a gear change:
    //   "Sure, let me pull together a simple visual"  <- turn 1
    //   ...seam...
    //   "Yes. On the canvas, you've got a block diagram"  <- turn 2
    // Half of every reply in a real session was this throat-clearing. The
    // model cannot merge the two turns, but it CAN stay silent for the first
    // one, which collapses the seam to a short pause.
    expect(text).toMatch(/without saying|say nothing|silently/i)
    expect(text).toMatch(/let me/i)
  })

  it('keeps her talking about the ideas rather than the canvas', () => {
    // Observed: "All set. The expanded view now shows...", "Clean slate is
    // up.", "All cleaned up. You're now looking at..." — narrating the artifact
    // instead of the thinking.
    expect(text).toMatch(/the idea|the thinking|what it means/i)
  })

  it('keeps the plumbing out of her mouth', () => {
    // Observed, verbatim: "It's probably still drawing in the background right
    // now. These full redraws can take a moment, and I shouldn't start another
    // one while it's in progress." That is my implementation leaking into her
    // voice, and it reads as apologising for the software.
    expect(text).toMatch(/redraw|render|in flight|plumbing|internals/i)
  })

  it('teaches that arrangement is something she can change', () => {
    // Reported: "I asked to have it redrawn linearly, she said she did it, but
    // it didn't change." She had no notion that SHAPE was changeable, so a
    // request about arrangement produced a redraw of identical content.
    expect(text).toMatch(/linearly|arrangement|shape/i)
  })

  it('tells her to ring nodes while walking through them', () => {
    // Observed: a five-step walkthrough with focus never called once, so the
    // user heard a tour of a diagram with nothing lighting up.
    expect(text).toMatch(/ring each|as you reach it|keeps pace/i)
  })

  it('asks her to say exact node labels during walkthroughs', () => {
    expect(text).toMatch(/node labels? exactly|exact node labels?/i)
  })

  it('reads as a description of the mode, not a compliance checklist', () => {
    // Tone regression guard. An earlier revision accrued one prohibition per
    // bug fixed — 11 of 20 sentences — and the model's speech went stilted to
    // match. Behaviour belongs as intent, not as a list of things to avoid.
    const sentences = text.split(/(?<=\.) /).filter(Boolean)
    const prohibitions = sentences.filter((s: string) => /\b(never|do NOT|don't|must not)\b/i.test(s))

    expect(prohibitions.length / sentences.length).toBeLessThan(0.2)
  })
})
