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

  it('makes visualization a deliberate voice decision', () => {
    expect(text).toMatch(/visualize/)
    expect(text).toMatch(/user asks|clearly help/i)
    expect(text).toMatch(/edits? in place/i)
    expect(text).not.toMatch(/draw first/i)
  })

  it('requires an actual tool action for explicit visual requests', () => {
    expect(text).toMatch(/spoken description alone does not satisfy/i)
    expect(text).toMatch(/what would that look like/i)
  })

  it('teaches the model to act sequentially across one human turn', () => {
    expect(text).toMatch(/several (?:model )?responses and tool rounds/i)
    expect(text).toMatch(/inspect its result/i)
    expect(text).toMatch(/do not schedule dependent actions together/i)
    expect(text).toMatch(/search.*visualize/i)
  })

  it('delegates research reluctantly without creating a second conversation authority', () => {
    expect(text).toMatch(/delegate_research/i)
    expect(text).toMatch(/substantial.*multi-source|deep research/i)
    expect(text).toMatch(/prefer web_search/i)
    expect(text).toMatch(/do not busy-poll/i)
    expect(text).toMatch(/research_search.*research_read/i)
    expect(text).toMatch(/you remain.*conversation|sole conversational authority/i)
  })

  it('explains the voice agent loop and its completion signal', () => {
    expect(text).toMatch(/each response is one inference step/i)
    expect(text).toMatch(/not necessarily the whole user turn/i)
    expect(text).toMatch(/tool result.*another inference/i)
    expect(text).toMatch(/tool-free response ends the loop/i)
    expect(text).toMatch(/while work remains.*call the next tool/i)
    expect(text).toMatch(/original user request is satisfied/i)
  })

  it('paces walkthrough camera moves with one explanation at a time', () => {
    expect(text).toMatch(/focus and zoom_to exactly one node/i)
    expect(text).toMatch(/explain only that node/i)
    expect(text).toMatch(/after that explanation has played/i)
    expect(text).toMatch(/never schedule multiple focus or zoom_to calls together/i)
  })

  it('explains that visualize returns before the drawing exists', () => {
    // Without this the model waits for a result that never comes, or announces
    // a picture that has not arrived. Both were observed.
    expect(text).toMatch(/status: drawing/)
  })

  it('steers single edits to the instant tools', () => {
    for (const tool of ['focus', 'zoom_to', 'rename', 'connect', 'disconnect', 'remove', 'go_back']) {
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

  it('does not turn silent tool use into act-everything-before-speaking', () => {
    expect(text).toMatch(/silence.*skip.*filler/i)
    expect(text).toMatch(/does not mean.*defer all speech/i)
    expect(text).toMatch(/act, observe, explain/i)
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
    expect(text).toMatch(/call visualize with the requested arrangement/i)
  })

  it('does not use generated transcript timing as the walkthrough clock', () => {
    expect(text).not.toMatch(/canvas follows those labels|without spending a tool round per node/i)
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
