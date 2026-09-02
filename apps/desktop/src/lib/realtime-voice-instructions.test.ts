import { describe, expect, it } from 'vitest'

import {
  REALTIME_INSTRUCTIONS_FOR_TESTS,
  VOICE_ACTION_LOOP_INSTRUCTIONS_FOR_TESTS
} from './realtime-voice'

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
    expect(text).toMatch(/visual action advances the user’s goal/i)
  })

  it('teaches the model to act sequentially across one human turn', () => {
    expect(text).toMatch(/continue after each tool result/i)
    expect(text).toMatch(/inspect each real result/i)
    expect(text).toMatch(/dependent actions sequentially/i)
    expect(text).toMatch(/independent reads may share one response/i)
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

  it('gives running background work a valid deferred terminal boundary', () => {
    expect(text).toMatch(/if research_status says running/i)
    expect(text).toMatch(/finish_turn with status deferred/i)
    expect(text).not.toMatch(/research_status says running[^.]*end normally/i)
  })

  it('teaches a general iterative agent loop with explicit completion', () => {
    expect(text).toMatch(/each response.*one step/i)
    expect(text).toMatch(/speech.*not.*completion|speaking.*not.*completion/i)
    expect(text).toMatch(/while work remains.*next useful tool/i)
    expect(text).toMatch(/finish_turn.*complete/i)
    expect(text).toMatch(/finish_turn.*blocked/i)
    expect(text).toMatch(/finish_turn.*deferred/i)
    expect(text).toMatch(/tool-free response.*candidate stop/i)
  })

  it('requires a requested answer to be spoken before declaring completion', () => {
    expect(VOICE_ACTION_LOOP_INSTRUCTIONS_FOR_TESTS).toMatch(/requested answer.*already.*spoken/i)
    expect(VOICE_ACTION_LOOP_INSTRUCTIONS_FOR_TESTS).toMatch(/acknowledg.*not.*completion/i)
  })

  it('keeps the core agent loop independent of any particular tool domain', () => {
    expect(VOICE_ACTION_LOOP_INSTRUCTIONS_FOR_TESTS).not.toMatch(
      /graph|canvas|node|subject|present_step|focus|camera|research|speed_draw/i
    )
  })

  it('does not prescribe a graph-specific state machine around the general loop', () => {
    expect(text).not.toMatch(/for a small new diagram/i)
    expect(text).not.toMatch(/call present_step for the NEXT subject/i)
    expect(text).not.toMatch(/repeat until every subject/i)
    expect(text).not.toMatch(/default to a guided walkthrough/i)
  })

  it('keeps visual capabilities synchronized without prescribing the route', () => {
    expect(text).toMatch(/present_step.*couple one bounded graph edit with focus and framing/is)
    expect(text).toMatch(/keep the current visual result visible while you explain/i)
    expect(text).toMatch(/choose what comes next through the same general agent loop/i)
    expect(text).toMatch(/actual spoken playback.*one spatial beat/i)
  })

  it('names the walkthrough tool and says no cue will arrive between beats', () => {
    expect(text).toMatch(/guided visual walkthrough[^.]*call present_step[^.]*nonfinal beat/i)
    expect(text).toMatch(/not waiting for the user or another cue/i)
  })

  it('reserves speed_draw for explicitly broad or all-at-once work', () => {
    expect(text).toMatch(/speed_draw only for an explicitly quick, all-at-once, rearranged, or wholesale/i)
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
    expect(text).toMatch(/present_step.*guided explanations/i)
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
