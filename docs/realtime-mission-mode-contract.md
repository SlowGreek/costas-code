# Realtime Mission Mode Contract

Mission Mode resumes the existing GPT Realtime executive agent when subordinate background research becomes ready. It must never create a second conversational authority or inject a synthetic user message.

## Shared identity and event contract

- The Desktop creates one opaque `mission_id` (`mission_<random>`) when `delegate_research` is accepted.
- `voice.realtime.delegate_research` receives that `mission_id` in addition to the research query.
- The server persists `mission_id` beside `artifact_id` and `delegation_id` in the research request metadata.
- After the delegation is terminal **and** `research.md` is verified non-empty, bounded, and session-scoped, the backend emits:

```text
voice.realtime.research.ready
{
  mission_id: string,
  artifact_id: string,
  delegation_id: string
}
```

- A failed delegation emits `voice.realtime.research.failed` with the same identities and a safe error string while the owning backend process is alive.
- Events are routed through the existing runtime-session `_emit` channel. They never enter normal chat completion delivery.
- Duplicate events are legal. Consumers must be idempotent.

## Mission state contract

The client mission state is one of:

```text
researching -> ready -> awaiting_boundary -> resuming -> presenting -> complete
                    \-> cancelled
researching/ready/awaiting_boundary/resuming -> failed
```

State carries `mission_id`, `artifact_id`, optional `delegation_id`, a short user-facing label, and the originating runtime session ID. A newer mission supersedes an older mission in the same runtime session.

## Safe automatic resumption

A ready mission may issue exactly one automatic continuation only when all are true:

- the Realtime connection is still open;
- the event belongs to the currently focused runtime session and current `mission_id`;
- the user is not speaking;
- assistant audio is not playing;
- no provider response is active;
- the mission was not cancelled, superseded, or already resumed.

No fixed sleep decides readiness. Provider/transport lifecycle events release the boundary.

Resume with a transient provider continuation, never a fake user message:

```json
{
  "type": "response.create",
  "response": {
    "instructions": "Background research for the current mission is ready. Call research_status for the current artifact, inspect relevant evidence with research_search and research_read, then continue the user's original mission."
  }
}
```

If the boundary is uncertain, remain `awaiting_boundary`. Manual “go on” still works through the normal user turn.

## Backend restart recovery

Delegation completion callbacks are process-local. If the backend restarts while research is running, the worker does not survive and the durable delegation is recovered as `unknown`; the old process cannot replay its terminal event.

- A Desktop connection that still owns the exact active mission reconciles its profile- and session-scoped `research_status` once after reconnect. `ready` continues through the normal safe-boundary gates; `unknown` or another terminal failure becomes `failed`.
- A fresh renderer does not auto-adopt the latest artifact as a new mission. The next normal user turn can recover the latest verified evidence through `research_status` without a synthetic user message or unsolicited speech.

## UI contract

Render one ambient mission capsule near existing voice/workbench controls. No new sidebar, dashboard, transcript row, or task console.

```text
● Researching <label>
✓ Evidence ready
● Building <label>
✓ Complete
```

The capsule is quiet, compact, accessible, and clickable only for minimal detail/cancel affordances. The canvas remains the primary progress surface.

## Non-negotiable invariants

- GPT Realtime remains the sole conversational and objective authority.
- Research workers produce evidence only and never control the canvas.
- No synthetic user messages.
- No auto-resume after barge-in, cancellation, session switch, stale event, or duplicate completion.
- At most one automatic `response.create` per mission readiness generation.
- Existing focus/draw playback barriers and ordinary voice chat must not degrade.
