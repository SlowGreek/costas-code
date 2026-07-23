---
sidebar_position: 16
title: "Persistent Goals"
description: "Set a standing goal and let Hermes keep working across turns until it's done. Our take on the Ralph loop."
---

# Persistent Goals (`/goal`)

`/goal` gives Hermes a standing objective that survives across turns. After every turn a lightweight judge model checks whether the goal is satisfied by the assistant's last response. If not, Hermes automatically feeds a continuation prompt back into the same session and keeps working — until the goal is achieved, you pause or clear it, or the turn budget runs out.

It's our take on the **Ralph loop**, directly inspired by [Codex CLI 0.128.0's `/goal`](https://github.com/openai/codex) by Eric Traut (OpenAI). The core idea — keep a goal alive across turns and don't stop until it's achieved — is theirs. The implementation here is independent and adapted to Hermes' architecture.

## When to use it

Use `/goal` for tasks where you want Hermes to iterate on its own without you re-prompting every turn:

- "Fix every lint error in `src/` and verify `ruff check` passes"
- "Port feature X from repo Y, including tests, and get CI green"
- "Investigate why session IDs sometimes drift on mid-run compression and write up a report"
- "Build a small CLI to rename files by their EXIF dates, then test it against the photos/ folder"

Tasks where the agent does one turn and stops don't need `/goal`. Tasks where *you'd otherwise have to say "keep going" three times* are where this shines.

## Quick start

```
/goal Fix every failing test in tests/hermes_cli/ and make sure scripts/run_tests.sh passes for that directory
```

What you'll see:

1. **Goal accepted** — `⊙ Goal set (20-turn budget): <your goal>`
2. **Turn 1 runs** — Hermes starts working as if you'd sent the goal as a normal message.
3. **Judge runs** — after the turn, the judge model decides `done` or `continue`.
4. **Loop fires if needed** — if `continue`, you'll see `↻ Continuing toward goal (1/20): <judge's reason>` and Hermes takes the next step automatically.
5. **Terminates** — eventually you see `✓ Goal achieved: <reason>` (completion, after second-stage verification), `🚧 Goal blocked — needs you: <reason>` (it needs your input), or `⏸ Goal paused — N/20 turns used` (budget or no-progress).

## Commands

| Command | What it does |
|---|---|
| `/goal <text>` | Set (or replace) the standing goal. Kicks off the first turn immediately so you don't need to send a separate message. |
| `/goal draft <text>` | Draft a structured completion contract from a plain-language objective, then set it. See [Completion contracts](#completion-contracts). |
| `/goal show` | Print the active goal's completion contract. |
| `/goal` or `/goal status` | Show the current goal, its status, and turns used. |
| `/goal pause` | Stop the auto-continuation loop without clearing the goal. (Refused on a `done`/`cleared` goal.) |
| `/goal resume` | Resume the loop from `paused` or `blocked` (resets the turn counter back to zero). Refused on a `done`/`cleared` goal — those are terminal. |
| `/goal clear` | Drop the goal entirely. |
| `/goal wait <pid> [reason]` | Park the loop on a background process — it stops re-poking the agent every turn while the process runs, and auto-resumes when it exits. |
| `/goal unwait` | Drop the wait barrier and resume the loop immediately. |

Works identically on the CLI and every gateway platform (Telegram, Discord, Slack, Matrix, Signal, WhatsApp, SMS, iMessage, Webhook, API server, and the web dashboard).

In the desktop app, the active standing goal is also pinned in the composer status stack with its turn budget, latest judge reason, and active/paused/blocked state. The card is backed by the same native `GoalManager` state as `/goal status`; it is not a separate desktop-only goal implementation.

## Completion contracts

A bare `/goal <text>` works fine, but a *vague* goal makes for vague judging — the judge can only check what you told it to want. Codex's `/goal` guidance makes the same point: a durable objective works best when it names **what done means, how to prove it, what not to break, what's in scope, and when to stop**. Hermes adapts this as an optional **completion contract** layered on top of the existing goal loop.

A contract has five fields, all optional:

| Field | Meaning |
|---|---|
| `outcome` | The single end state that must be true when done. |
| `verification` | The specific test / command / artifact that *proves* the outcome. |
| `constraints` | What must not change or regress. |
| `boundaries` | Which files, dirs, tools, or systems are in scope. |
| `stop_when` | The condition under which Hermes should stop and ask for input. |

When a contract is set, both prompts change: the **continuation prompt** tells the agent to target the verification surface and respect the constraints, and the **judge prompt** decides `done` *only when the verification criterion is met with concrete evidence* (a command result, file excerpt, test output) — not a loose "looks done" claim. This directly tightens the most common `/goal` failure mode (premature completion or endless over-continuation on an underspecified objective).

### Two ways to set a contract

**1. Let Hermes draft it** (recommended — adapted from Codex's "let the agent draft the goal" tip):

```
/goal draft Migrate the auth service from session cookies to JWT
```

Hermes expands your one-liner into a full contract via the `goal_judge` auxiliary model, sets it, and shows you the result so you can review or tighten any field. If the aux model is unavailable, it falls back to a plain free-form goal — drafting never blocks setting a goal.

**2. Write it inline** with `field: value` lines:

```
/goal Migrate auth to JWT
verify: pytest tests/auth passes
constraints: keep the /login response shape unchanged
boundaries: only touch services/auth and its tests
stop when: a DB schema migration is required
```

The first non-field line(s) are the goal headline; recognized field prefixes (`verify:`, `verified by:`, `constraints:`, `preserve:`, `boundaries:`, `scope:`, `stop when:`, `blocked:`, …) populate the contract. A plain goal with an incidental colon (`Fix bug: the parser drops commas`) is **not** mangled — only known field prefixes are pulled out.

Use `/goal show` to review the active contract. Contracts persist in `SessionDB.state_meta` alongside the goal, so they survive `/resume`. Old goals from before this feature load unchanged (no contract). Contracts and `/subgoal` criteria compose: subgoals fold into the contract as extra criteria the judge must also satisfy.

## Adding criteria mid-goal: `/subgoal`

While a goal is active you can append extra acceptance criteria with `/subgoal <text>` without resetting the loop. Each call adds one numbered item to the goal's subgoal list; the **continuation prompt** the agent sees on the next turn includes the original goal plus an "Additional criteria the user added mid-loop" block, and the **judge prompt** is rewritten so the verdict must consider every subgoal — the goal isn't marked done until the original objective **and** every subgoal are met.

| Command | What it does |
|---|---|
| `/subgoal <text>` | Append a new criterion to the active goal. Requires an active `/goal`. |
| `/subgoal` (no args) | Show the current numbered subgoal list. |
| `/subgoal remove <N>` | Remove the Nth subgoal (1-based). |
| `/subgoal clear` | Drop every subgoal but keep the original goal intact. |

Subgoals are persisted alongside the goal in `SessionDB.state_meta`, so they survive `/resume`. Setting a new `/goal <text>` replaces the goal and clears the subgoal list; `/goal clear` does the same.

Use this when you start a loop ("fix the failing tests") and notice partway through that you also want it to "and add a regression test for the bug you just patched" — `/subgoal add a regression test` tightens the success criteria without breaking the running loop.

## Parking on a background process: automatic, with a manual override

Some goals are gated on something that takes minutes and runs on its own — CI on a pushed PR, a long build, a test matrix, a deploy, a rate-limit cooldown. Without help, the goal loop would re-poke the agent every turn into "is it done yet?" busy-work while it waits.

**This is handled automatically.** Every turn, the judge is shown the agent's live background processes (the `terminal(background=true)` registry — pid, session id, command, uptime, recent output, and any `watch_patterns` / `notify_on_complete` trigger) alongside the goal and the agent's response. When the agent's progress is genuinely gated on one of them, the judge returns a **`wait`** verdict instead of `continue`, and the loop **parks**: the next turns are skipped (no judge call, no continuation, no turn consumed) until the wait is satisfied — then it resumes normally with the result in hand. The judge can also park on a **time** basis (`wait_for_seconds`) for backoff/cooldown waits. `/goal status` shows `⏳ Goal (parked …)` while parked.

The judge picks the right kind of wait from the process's own signal:

- **`wait_on_session <id>`** — releases when the process's *own trigger* fires: it exits, **or** (if it was started with `watch_patterns`) its pattern matches. This is the one for a long-lived watcher / server / poller that signals **mid-run** (e.g. a build process that prints `BUILD SUCCESSFUL` and keeps running, or a `notify_on_complete` watcher) and may never exit on its own.
- **`wait_on_pid <pid>`** — releases on process exit only.
- **`wait_for_seconds <n>`** — releases after a fixed delay.

You don't type anything for this — it's the judge's decision, made from the process context the loop hands it. The manual commands exist as an override:

| Command | What it does |
|---|---|
| `/goal wait <pid> [reason]` | Manually park the loop until the process with that PID exits. |
| `/goal unwait` | Clear any wait barrier (judge- or manually-set) and resume immediately. |

The barrier (pid- or time-based) is persisted with the goal in `SessionDB.state_meta`, so it survives `/resume`. `/goal pause`, `/goal resume`, and `/goal clear` all drop it. If the PID is already dead when the barrier is set (or dies while parked), or the time deadline passes, the barrier clears on the next check — a stale barrier can never wedge the loop. Every wait also carries a **bounded max-park ceiling** (`goals.max_park_seconds`, default 30 min): even a pid that never exits or a watcher that never fires is force-released by then, and the goal wakes on its own. Timed and bare-pid waits wake **autonomously** through Hermes' existing idle/notification loop — you don't have to send a message to un-park them; where possible a bare-pid wait is upgraded to a session-backed wait so it wakes the instant the process signals.

Typical flow: the agent pushes a PR, starts a CI watcher with `terminal(background=true, notify_on_complete=true)`, and reports "watching CI." The judge sees the watcher process still running, returns `wait` on its pid, and the loop goes quiet — then picks back up the instant CI finishes and judges the goal against the actual result.

## Behavior details

### The judge

After every turn, Hermes calls an auxiliary model with:

- The standing goal text
- The agent's most recent final response (last ~4 KB of text), **fenced as untrusted data** — the judge is explicitly told never to follow any instruction inside the response or background-process output, so a task can't prompt-inject the judge into a false "done".
- Any live background processes, also fenced as untrusted.
- A system prompt telling the judge to reply with strict JSON and one of four verdicts: `done`, `blocked`, `continue`, or `wait`. The legacy `{"done": <bool>, "reason": "…"}` shape is still accepted.

The judge is deliberately conservative: it marks a goal `done` only when the response shows **concrete evidence** the goal is complete (a command result, file contents, a test/benchmark output) — not a bare "looks done" claim. If the agent is stuck needing you (missing input, a decision, credentials) or the goal is unachievable, the judge returns **`blocked`** instead — an honest "not achieved, needs you" state, never dressed up as success. The judge is also given explicit **test-theater** guidance: it rejects hardcoded expectations, mocking the unit under test, assertions fitted to after-the-fact output, and skipped/ignored tests dressed up as passing (honest fakes at a real environment boundary are fine).

### Blocked ≠ achieved

A `blocked` goal is a durable, honest control state: the loop stops (like paused) but the UX is truthful — you'll see `🚧 Goal blocked — needs you: <reason>`, never `✓ Goal achieved`. Reply with what it needs, then `/goal resume` to unblock and continue. Blocked goals are recoverable; `done` and `cleared` goals are **terminal** — `/goal resume` and `/goal pause` refuse them, and a fresh session never resurrects a completed or cleared goal.

### Second-stage completion verification

A single "I'm done" from the model is not proof. When the first-stage judge returns `done`, Hermes runs a cheap, cache-safe **second-stage verifier** over the *actual* evidence available this session — recent tool/command results and background-process output — before accepting completion. It **fails closed**: if the evidence doesn't corroborate the claim (or the verifier itself can't run), the goal is **not** marked done and the loop keeps working. For a goal with a concrete `verification` requirement, unshown proof means "not done"; for a pure free-form/prose goal with nothing to independently check, the verifier steps aside (it never fabricates evidence that doesn't exist). Turn it off with `goals.verify_completion: false` to trust the first-stage judge alone.

### No-progress detection

If the judge returns `continue` with the *same gap* turn after turn — the agent is spinning, not closing the hole — Hermes auto-pauses and escalates instead of grinding the whole budget on one stuck step. The prior turn's gap is fed back into the next judge call so it can tell real progress from a reworded repeat, and repeats are matched by a normalized fingerprint (not a brittle exact-string compare). Tune the threshold with `goals.max_no_progress` (default 4).

### Fail-open semantics

If the judge errors (network blip, malformed response, unavailable aux client), Hermes treats the verdict as `continue` — a broken judge never wedges progress. The **turn budget** is the real backstop.

### Turn budget

Default is 20 continuation turns (`goals.max_turns` in `config.yaml`). When the budget is hit, Hermes auto-pauses and tells you exactly how to proceed:

```
⏸ Goal paused — 20/20 turns used. Use /goal resume to keep going, or /goal clear to stop.
```

`/goal resume` resets the counter to zero, so you can keep going in measured chunks.

### User messages always preempt

Any real message you send while a goal is active takes priority over the continuation loop. On the CLI your message lands in `_pending_input` ahead of the queued continuation; on the gateway it goes through the adapter FIFO the same way. The judge runs again after your turn — so if your message happens to complete the goal, the judge will catch it and stop.

### Mid-run safety (gateway)

While an agent is already running, `/goal status`, `/goal pause`, `/goal clear`, `/goal wait`, and `/goal unwait` are safe to run — they only touch control-plane state and don't interrupt the current turn. Setting a **new** goal mid-run (`/goal <new text>`) is rejected with a message telling you to `/stop` first, so the old continuation can't race the new one.

### Persistence

Goal state lives in `SessionDB.state_meta` keyed by `goal:<session_id>`. That means `/resume` picks up right where you left off — set a goal, close your laptop, come back tomorrow, `/resume`, and the goal is still standing exactly as you left it (active, paused, or done).

### Prompt cache

The continuation prompt is a plain user-role message appended to history. It does **not** mutate the system prompt, swap toolsets, or touch the conversation in any way that invalidates Hermes' prompt cache. Running a 20-turn goal costs the same cache-wise as 20 turns of normal conversation.

## Configuration

Add to `~/.hermes/config.yaml`:

```yaml
goals:
  # Max continuation turns before Hermes auto-pauses and asks you to
  # /goal resume. Default 20. Lower this if you want tighter loops;
  # raise it for long-running refactors.
  max_turns: 20
  # Run a cheap second-stage verifier over real tool/command evidence
  # before accepting a "done" verdict (fails closed). Set false to trust
  # the first-stage judge alone. Default true.
  verify_completion: true
  # Hard ceiling (seconds) on how long ANY /goal wait barrier parks the
  # loop before it is force-released, so a wait that never fires can't
  # wedge the goal. Default 1800 (30 min).
  max_park_seconds: 1800
  # Auto-pause after this many turns in a row with no observable progress
  # on the same gap. Default 4.
  max_no_progress: 4
```

### Choosing the judge model

The judge uses the `goal_judge` auxiliary task. By default it resolves to your main model (see [Auxiliary Models](/user-guide/configuration#auxiliary-models)). If you want to route the judge to a cheap fast model to keep costs down, add an override:

```yaml
auxiliary:
  goal_judge:
    provider: openrouter
    model: google/gemini-3-flash-preview
```

The judge call is small (~200 output tokens) and runs once per turn, so a cheap fast model is usually the right call.

## Example walkthrough

```
You: /goal Create four files /tmp/note_{1..4}.txt, one per turn, each containing its number as text

  ⊙ Goal set (20-turn budget): Create four files /tmp/note_{1..4}.txt, one per turn, each containing its number as text

Hermes: Creating /tmp/note_1.txt now.
  💻 echo "1" > /tmp/note_1.txt   (0.1s)
  I've created /tmp/note_1.txt with the content "1". I'll continue with the remaining files on the next turn as you specified.

  ↻ Continuing toward goal (1/20): Only 1 of 4 files has been created; 3 files remain.

Hermes: [Continuing toward your standing goal]
  💻 echo "2" > /tmp/note_2.txt   (0.1s)
  Created /tmp/note_2.txt. Two more to go.

  ↻ Continuing toward goal (2/20): 2 of 4 files created; 2 remain.

Hermes: [Continuing toward your standing goal]
  💻 echo "3" > /tmp/note_3.txt   (0.1s)
  Created /tmp/note_3.txt.

  ↻ Continuing toward goal (3/20): 3 of 4 files created; 1 remains.

Hermes: [Continuing toward your standing goal]
  💻 echo "4" > /tmp/note_4.txt   (0.1s)
  All four files have been created: /tmp/note_1.txt through /tmp/note_4.txt, each containing its number.

  ✓ Goal achieved: All four files were created with the specified content, completing the goal.

You: _
```

Four turns, one `/goal` invocation, zero "keep going" prompts from you.

## When the judge gets it wrong

No judge is perfect. Two failure modes to watch for:

**False negative — judge says continue when the goal is actually done.** The turn budget catches this. You'll see `⏸ Goal paused` and can `/goal clear` or just send a new message.

**False positive — judge says done when work remains.** The second-stage verifier catches most of these before you ever see `✓ Goal achieved`: an uncorroborated "done" is downgraded back to `continue`. If one still slips through, send a follow-up message to continue, or re-set the goal more precisely: `/goal <more specific text>`. The judge's system prompt is deliberately conservative (and evidence-driven) to make false positives rarer than false negatives.

**Needs-you — judge says blocked.** If Hermes stops with `🚧 Goal blocked`, it has decided it genuinely can't proceed without you (missing input, a decision, credentials, or an unachievable ask). Give it what it needs and `/goal resume`, or `/goal clear` if the objective no longer makes sense.

If you find a judge verdict unconvincing, the reason text in the `↻ Continuing toward goal` or `✓ Goal achieved` line tells you exactly what the judge saw. That's usually enough to diagnose whether the goal text was ambiguous or the model's response was.

## Attribution

`/goal` is Hermes' take on the **Ralph loop** pattern. The user-facing design — keep a goal alive across turns, don't stop until it's achieved, with create/pause/resume/clear controls — was popularised and shipped in [Codex CLI 0.128.0](https://github.com/openai/codex) by Eric Traut on OpenAI's Codex team. Our implementation is independent (central `CommandDef` registry, `SessionDB.state_meta` persistence, auxiliary-client judge, adapter-FIFO continuation on the gateway side) but the idea is theirs. Credit where credit's due.
