---
name: super-goal
description: Use when one substantial objective should be delegated to a single background worker while the parent session defines acceptance criteria, remains accountable, independently verifies evidence, and reports criterion-based progress.
version: 1.0.0
author: Costas Panay + Hermes Agent
license: Apache-2.0
metadata:
  hermes:
    tags: [delegation, supervision, goals, verification, multi-agent]
    related_skills: [hermes-agent, requesting-code-review, test-driven-development]
---

# Super Goal

## Overview

Super Goal is a two-layer execution loop. The current, human-facing Hermes
session is the **parent supervisor**; exactly one delegated leaf is the
**execution child**. The parent owns the objective, acceptance criteria,
progress ledger, safety decisions, verification, and final verdict. The child
owns implementation inside the authority explicitly granted to it.

This is a supervision discipline, not permission to trust a child report. A
child saying “done” starts parent verification; it never completes the goal by
itself.

## When to Use

Use Super Goal when all of these are true:

- the objective is substantial enough to benefit from an isolated worker;
- the work can be expressed with falsifiable acceptance criteria;
- one child can execute without asking the user questions;
- the parent can independently inspect the resulting files, commands, URLs, or
  other evidence.

Do **not** use it for a single tool call, a small mechanical edit, work that
requires interactive clarification, or a durable task that must survive the
parent process exiting. Use `cronjob` or a tracked background process for truly
durable execution.

## Invariants

1. **One accountable parent.** The current session owns the verdict and user
   communication.
2. **Exactly one execution child at a time.** Use one `delegate_task` leaf. Do
   not batch writers and do not let the child delegate further.
3. **Criteria before delegation.** Define 3–8 stable, falsifiable criteria
   before starting the child.
4. **No polling.** `delegate_task` returns immediately and delivers an
   automatic completion notification back into this conversation. Do not call
   status tools, sleep, or repeatedly inspect live transcripts while it runs.
5. **Evidence-derived progress.** Progress is passed criteria divided by total
   criteria, never an estimate based on time, tokens, tool calls, or prose.
6. **Independent verification.** The parent reads the changed artifacts and
   runs the smallest authoritative checks itself.
7. **Bounded replacement.** At most one replacement child may be started, and
   only after the original child has returned or failed terminally.

## Start the Goal

### 1. Freeze the contract

Preserve the user’s complete objective. Derive 3–8 acceptance criteria, each
with a short stable id and a checkable success condition. Record explicit
non-goals and authority boundaries when they matter.

A good criterion names observable proof:

```text
C1 — The packaged app displays “Costas Code” in native app metadata.
Proof: package metadata test and packaged-build inspection.
```

A bad criterion is subjective or process-shaped:

```text
C1 — Make the branding look good.
```

The criterion ids and meanings remain fixed for this run. New user guidance may
clarify execution, but changing the objective or acceptance contract starts a
new Super Goal.

### 2. Create the parent ledger

Use `todo` to create a compact supervision ledger:

- one in-progress item for the objective;
- one pending item per acceptance criterion;
- one final pending item for independent verification and reporting.

Only one item may be `in_progress`. Update a criterion to `completed` only after
the parent has concrete evidence. If the user steers the work while the child is
running, record the guidance in the conversation and ledger; do not pretend it
was delivered to a leaf that cannot receive mid-run messages.

### 3. Delegate exactly once

Call `delegate_task` with `role="leaf"`. Pass a self-contained contract because
the child has no conversation memory. Include:

- the complete objective and every criterion;
- repository and relevant absolute paths;
- current branch and working-tree constraints;
- required tests, builds, or other evidence;
- files or systems it may and may not modify;
- known pre-existing changes that must be preserved;
- requested output: changed paths, commands run, real results, blockers, and
  verifiable handles for external side effects;
- the following guard:

> You are the single execution child. Do not delegate, ask the user questions,
> publish, push, merge, or claim completion without evidence. Preserve existing
> unrelated work. Return the exact paths, commands, results, and blockers to the
> parent; the parent independently decides whether the objective is complete.

Prefer a child that writes only in an isolated worktree when the parent checkout
is already dirty or another writer may be active. If the child must work in the
parent checkout, state that it is the sole writer and list the pre-existing
changes it must preserve.

### 4. End the wait turn

After `delegate_task` returns its handle, tell the user the child is running and
end the turn. Do not wait or poll. The result re-enters the conversation as a
new message when all delegated work is finished.

## Handle the Child Result

### 1. Treat the report as a lead, not proof

Map each child claim to a criterion. Mark claims as **unverified** until the
parent checks the original source:

- file claims → read the actual files and inspect the complete diff;
- test claims → rerun the targeted authoritative command;
- Git claims → inspect status, diff, branch, and history with Git;
- remote writes → fetch the URL, issue, PR, release, or API object;
- generated artifacts → verify the path, type, size, and ability to open or run.

Subagent summaries are self-reports. Never tell the user an external side effect
succeeded solely because the child said so.

### 2. Verify vertically

Verify one criterion end-to-end at a time. For each criterion:

1. inspect the implementation or artifact;
2. run the smallest decisive check;
3. record the concrete evidence in the ledger;
4. mark it completed only when the evidence proves the criterion.

After targeted checks pass, run the relevant regression suite or build. Review
the complete diff for unrelated changes, secrets, generated credentials, or
unsafe commands before any commit or publication.

### 3. Decide

- **All criteria pass:** complete the objective and final verification items,
  then report criterion-by-criterion evidence.
- **Fixable gap that the parent can safely resolve:** fix it directly with the
  normal project workflow and verify again. Do not create a child merely to
  avoid parent accountability.
- **Substantial incomplete work or terminal child failure:** preserve the first
  child’s artifacts and start the single permitted replacement child with the
  original fixed criteria plus exact failure evidence and handoff paths.
- **Credential, product, or external decision required:** mark the affected item
  blocked, state the exact decision needed, and ask the user. Never invent a
  decision to keep the loop moving.

A second failed child ends the loop as blocked. Do not recurse into an unbounded
agent chain.

## Replacement Rules

Before replacement, inspect and preserve all useful work:

1. Record the original child’s returned evidence and terminal failure.
2. Inspect Git status/diff and untracked files in its worktree or checkout.
3. Keep committed work on its branch. For uncommitted work, preserve a binary
   diff plus safe copies and hashes when practical.
4. Start one replacement with the same immutable criteria, the failure reason,
   preserved handoff locations, and the same no-delegation guard.
5. Never delete the failed worktree as part of replacement.

If useful work cannot be preserved losslessly, stop and ask the user instead of
replacing.

## User Steering

Mid-run user guidance has three cases:

- **Clarification within the fixed contract:** record it for parent verification
  and, if a replacement becomes necessary, include it in that child’s contract.
- **Urgent stop:** stop supervising and report that a `delegate_task` leaf cannot
  be interactively paused through this skill; do not claim the underlying work
  was forcibly stopped.
- **Objective or criteria changed:** retire the current ledger and start a new
  Super Goal. Never silently rewrite acceptance after seeing the result.

## Common Pitfalls

1. **Polling the child.** Live transcripts are for exceptional debugging or a
   user explicitly asking to watch, not routine supervision. Rely on automatic
   completion delivery.
2. **Delegating before defining proof.** This produces confident prose with no
   decisive finish line. Freeze criteria first.
3. **Accepting green text.** Always rerun decisive checks and inspect artifacts.
4. **Parallel writers.** One Super Goal has one execution child. Use separate
   Super Goals or isolated worktrees for independent workstreams.
5. **Passing too little context.** The child knows nothing about this chat. Give
   it paths, constraints, pre-existing changes, and exact proof requirements.
6. **Passing secrets.** Provide secret names or approved access mechanisms, not
   credential values in prompts or ledgers.
7. **Unbounded retries.** One replacement is the hard limit.

## Verification Checklist

- [ ] The full objective and 3–8 stable criteria were recorded before delegation
- [ ] Exactly one leaf child ran at a time
- [ ] The child contract included paths, constraints, tests, and the no-delegation guard
- [ ] The parent did not poll while waiting for automatic completion notification
- [ ] Every completed criterion has concrete parent-verified evidence
- [ ] Targeted checks and the relevant regression suite/build passed
- [ ] The complete diff was reviewed for unrelated changes and secrets
- [ ] No more than one replacement child was used
- [ ] The final report distinguishes verified facts from remaining blockers
