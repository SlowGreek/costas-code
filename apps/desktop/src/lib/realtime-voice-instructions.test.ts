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
    expect(text).toMatch(/speed_draw/)
    expect(text).toMatch(/user explicitly asks/i)
    expect(text).toMatch(/edits? in place/i)
    expect(text).not.toMatch(/draw first/i)
  })

  it('requires an actual tool action for explicit visual requests', () => {
    expect(text).toMatch(/spoken description alone does not satisfy/i)
    expect(text).toMatch(/what would that look like/i)
  })

  it('teaches the model to act sequentially across one human turn', () => {
    expect(text).toMatch(/continue.*after each tool result/i)
    expect(text).toMatch(/inspect its result/i)
    expect(text).toMatch(/do not schedule unknown dependencies together/i)
    expect(text).toMatch(/search.*speed_draw/i)
  })

  it('delegates research reluctantly without creating a second conversation authority', () => {
    expect(text).toMatch(/delegate_research/i)
    expect(text).toMatch(/substantial.*multi-source|deep research/i)
    expect(text).toMatch(/prefer web_search/i)
    expect(text).toMatch(/do not busy-poll/i)
    expect(text).toMatch(/research_search.*research_read/i)
    expect(text).toMatch(/you remain.*conversation|sole conversational authority/i)
    expect(text).toMatch(/readiness continuation|safe boundary/i)
  })

  it('explains the voice agent loop and its completion signal', () => {
    expect(text).toMatch(/continue.*after each tool result/i)
    expect(text).toMatch(/response without a tool ends/i)
    expect(text).toMatch(/while work remains.*call the next tool/i)
    expect(text).toMatch(/original user request is satisfied/i)
  })

  it('paces walkthrough camera moves with one explanation at a time', () => {
    expect(text).toMatch(/use add_node, focus, and zoom_to for exactly one node/i)
    expect(text).toMatch(/explain only that node/i)
    expect(text).toMatch(/after (?:that|the current) explanation.*played/i)
    expect(text).toMatch(/never schedule multiple focus or zoom_to calls together/i)
  })

  it('names the next action explicitly instead of saying "move on"', () => {
    // Regression guard for the live loop stall. 9d98ddabaf said "call focus
    // for the next node and repeat" and the model advanced on its own; a
    // later edit softened it to "move to the next node", which reads as
    // "wait for something" and the walkthrough died after one node. The
    // instruction must name the TOOL, not the intention.
    expect(text).toMatch(/call focus (and zoom_to )?for the next/i)
    expect(text).not.toMatch(/after that explanation has played, move to the next node/i)
  })

  it('treats ordinary show-me language as an implicit guided walkthrough', () => {
    expect(text).toMatch(/show me.*what would that look like.*how does this work.*step by step/is)
    expect(text).toMatch(/default.*guided walkthrough/i)
    expect(text).toMatch(/add_node.*focus.*zoom_to.*explain only that node/is)
    expect(text).toMatch(/user should not have to ask.*each visual action/i)
  })

  it('tells the model to keep going without waiting to be prompted', () => {
    // The stall shape: the model explains one node, then waits. Nothing was
    // ever going to prompt it, so the walkthrough ended there.
    expect(text).toMatch(/you are not waiting for the user/i)
    expect(text).toMatch(/no one will prompt you between nodes/i)
    expect(text).toMatch(/keep going until every node has been covered/i)
  })

  it('reserves speed_draw for an explicitly static or all-at-once request', () => {
    expect(text).toMatch(/speed_draw only when.*quick draft.*all at once.*rearrange/is)
    expect(text).not.toMatch(/SHAPE[^.]*step by step/i)
  })

  it('teaches the full cinematic camera grammar without autoplay', () => {
    for (const tool of ['zoom_to', 'frame_nodes', 'pan_view', 'zoom_view', 'reset_view']) {
      expect(text, `${tool} missing from camera instructions`).toMatch(new RegExp(tool))
    }

    expect(text).toMatch(/composition anchor/i)
    expect(text).toMatch(/cut, quick, smooth, or dramatic/i)
    expect(text).toMatch(/actual spoken playback/i)
    expect(text).toMatch(/one spatial beat/i)
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

  it('uses one consistent focus rule and preserves incremental add-then-connect', () => {
    expect(text).toMatch(/focus automatically.*guided/i)
    expect(text).toMatch(/add_node.*then connect/i)
  })

  it('keeps implementation vocabulary out of model-facing instructions', () => {
    expect(text).not.toMatch(/mute diagrammer|backward-compatible|inference step|tool rounds?/i)
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
    expect(text).toMatch(/call speed_draw with the requested arrangement/i)
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
