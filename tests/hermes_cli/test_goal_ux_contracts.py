"""Goal-loop UX contracts: autonomy, judging visibility, and verifier posture.

Three compounding causes of a clunky `/goal`, each pinned by the tests below.
All three are behavior contracts, never snapshots of prompt wording — they
assert what the loop must *do*, so the prompts stay editable.

1. AUTONOMY. Every continuation template ended with "If you are blocked and
   need input from the user, say so clearly and stop." A standing goal is a
   standing mandate: the user already said "don't stop until X". Instructing
   the agent to stop and ask converts routine decisions ("shall I commit?")
   into hard stops. Observed in the wild: 3 of 4 blocked goals in the local
   state DB were the agent asking permission, not a real blocker
   ("awaiting user decision", "whether to merge", "whether to commit and
   push"). Reversible, in-scope decisions must be made, not escalated.

2. JUDGING VISIBILITY. The judge (and, on DONE, the verifier) run AFTER
   `message.complete` is emitted. The UI paints "finished" while one or two
   auxiliary LLM round-trips are still running, so the app looks idle when it
   isn't. The loop must announce that it is judging.

3. VERIFIER POSTURE. `verify_completion` fails closed: an unverified DONE is
   downgraded to CONTINUE. That is correct for a bare claim, but it must not
   silently veto forever — a repeatedly-verified-then-downgraded goal is
   indistinguishable from a hang.
"""

from __future__ import annotations

import re

import pytest

from hermes_cli import goals


# ── 1. Autonomy ──────────────────────────────────────────────────────

ALL_CONTINUATION_TEMPLATES = [
    ("plain", goals.CONTINUATION_PROMPT_TEMPLATE),
    ("contract", goals.CONTINUATION_PROMPT_WITH_CONTRACT_TEMPLATE),
    ("subgoals", goals.CONTINUATION_PROMPT_WITH_SUBGOALS_TEMPLATE),
]

# Phrasings that invite the agent to hand routine decisions back to the user.
_PERMISSION_SEEKING = re.compile(
    r"(need input from the user|ask the user (?:for|whether)|"
    r"wait for (?:the )?user (?:input|decision)|request permission)",
    re.IGNORECASE,
)


@pytest.mark.parametrize("name,template", ALL_CONTINUATION_TEMPLATES)
def test_continuation_prompt_does_not_invite_permission_seeking(name, template):
    """A standing goal is a standing mandate to proceed.

    The user set the goal precisely so the agent would keep going; telling it
    to stop whenever it wants input turns every reversible decision into a
    blocked goal.
    """
    assert not _PERMISSION_SEEKING.search(template), (
        f"{name} continuation template invites the agent to stop and ask; a "
        "standing goal already authorises reversible in-scope decisions"
    )


@pytest.mark.parametrize("name,template", ALL_CONTINUATION_TEMPLATES)
def test_continuation_prompt_grants_autonomy_for_reversible_work(name, template):
    """The replacement must be an explicit mandate, not just a deletion.

    Removing the stop-and-ask line without saying "decide and proceed" leaves
    the model's default deference intact.
    """
    lowered = template.lower()
    assert "decide" in lowered or "proceed" in lowered, (
        f"{name} continuation template must explicitly authorise the agent to "
        "decide and proceed on reversible, in-scope work"
    )


@pytest.mark.parametrize("name,template", ALL_CONTINUATION_TEMPLATES)
def test_continuation_prompt_still_allows_a_real_stop(name, template):
    """Autonomy is not recklessness — the escape hatch must survive.

    Genuinely irreversible or out-of-scope work (destructive commands, missing
    credentials) must still stop. A prompt that removes every stop condition
    would trade one failure mode for a worse one.
    """
    lowered = template.lower()
    assert "stop" in lowered, (
        f"{name} continuation template must retain a stop condition for "
        "genuinely irreversible or out-of-scope work"
    )


def test_judge_prompt_distinguishes_asking_from_being_blocked():
    """BLOCKED must mean 'cannot proceed', not 'chose to ask'.

    Without this the judge honestly reports a permission-ask as blocked and
    the loop halts on work the agent was authorised to do.
    """
    lowered = goals.JUDGE_SYSTEM_PROMPT.lower()
    assert "permission" in lowered, (
        "the judge prompt must tell BLOCKED apart from the agent merely "
        "asking permission for work the standing goal already authorises"
    )


# ── 2. Judging visibility ────────────────────────────────────────────


def test_status_callback_announces_judging_before_the_judge_call(monkeypatch):
    """`evaluate_after_turn` must announce that it is judging.

    The gateway emits `message.complete` before calling this, so without a
    status signal the UI shows an idle app through one or two auxiliary LLM
    round-trips (judge, then verifier on DONE).
    """
    seen: list[tuple[str, str | None]] = []

    monkeypatch.setattr(
        goals,
        "judge_goal",
        lambda *a, **k: ("continue", "keep going", False, None, False),
    )

    mgr = goals.GoalManager(session_id="judging-status-sid")
    mgr.set("ship it")

    mgr.evaluate_after_turn(
        "did some work",
        status_callback=lambda kind, text=None: seen.append((kind, text)),
    )

    kinds = [k for k, _ in seen]
    assert "judging" in kinds, (
        "evaluate_after_turn must emit a 'judging' status before the judge "
        f"call so the UI can show progress; got {kinds}"
    )


def test_judging_status_is_cleared_when_the_verdict_lands(monkeypatch):
    """A 'judging' indicator that never clears is worse than none."""
    seen: list[tuple[str, str | None]] = []

    monkeypatch.setattr(
        goals,
        "judge_goal",
        lambda *a, **k: ("continue", "keep going", False, None, False),
    )

    mgr = goals.GoalManager(session_id="judging-clear-sid")
    mgr.set("ship it")
    mgr.evaluate_after_turn(
        "did some work",
        status_callback=lambda kind, text=None: seen.append((kind, text)),
    )

    kinds = [k for k, _ in seen]
    assert kinds.index("judging") < len(kinds) - 1 or "judged" in kinds, (
        f"the judging status must be followed by a terminal signal; got {kinds}"
    )


def test_status_callback_is_optional(monkeypatch):
    """Callers that don't pass a callback must be unaffected (CLI, kanban)."""
    monkeypatch.setattr(
        goals,
        "judge_goal",
        lambda *a, **k: ("continue", "keep going", False, None, False),
    )

    mgr = goals.GoalManager(session_id="judging-optional-sid")
    mgr.set("ship it")
    decision = mgr.evaluate_after_turn("did some work")

    assert decision["verdict"] == "continue"


# ── 3. Verifier posture ──────────────────────────────────────────────


def test_repeated_verifier_downgrade_does_not_loop_forever(monkeypatch):
    """A fail-closed verifier must not veto the same DONE indefinitely.

    Failing closed is right — an unverified claim is not proof. But if the
    judge keeps saying DONE and the verifier keeps downgrading it, the goal
    burns its whole budget invisibly and looks hung. After a bounded number of
    downgrades the loop must surface the disagreement to the user instead of
    silently continuing.
    """
    monkeypatch.setattr(
        goals,
        "judge_goal",
        lambda *a, **k: ("done", "looks done", False, None, False),
    )
    monkeypatch.setattr(
        goals,
        "verify_completion",
        # (confirmed, reason, infra_failed)
        lambda *a, **k: (False, "no concrete evidence shown", False),
    )

    mgr = goals.GoalManager(session_id="verifier-loop-sid")
    mgr.set("ship it")

    decisions = []
    for _ in range(goals.MAX_VERIFY_DOWNGRADES + 2):
        decision = mgr.evaluate_after_turn("all done, trust me")
        decisions.append(decision)
        if not decision.get("should_continue"):
            break

    last = decisions[-1]
    # The verdict field stays "continue" (the judge's DONE was downgraded);
    # what must change is that the LOOP stops and the goal parks visibly.
    assert not last["should_continue"], (
        "a repeatedly-downgraded DONE must stop the loop rather than "
        f"continuing forever; ran {len(decisions)} rounds"
    )
    assert last["status"] == "paused", (
        f"the standoff must park the goal visibly; got status={last['status']}"
    )
    assert len(decisions) <= goals.MAX_VERIFY_DOWNGRADES, (
        f"must stop within MAX_VERIFY_DOWNGRADES rounds; took {len(decisions)}"
    )
    # The user needs to know WHY, and what to do about it.
    assert "corroborat" in last["message"].lower()
    assert mgr.state.paused_reason and "corroborat" in mgr.state.paused_reason


def test_a_verified_done_resets_the_downgrade_counter(monkeypatch):
    """The counter tracks a *consecutive* standoff, not lifetime downgrades.

    A goal that stumbles once and then genuinely completes must not carry that
    strike forward into a later goal on the same session.
    """
    outcomes = iter([
        (False, "no evidence yet", False),
        (True, "tests shown passing", False),
    ])
    monkeypatch.setattr(
        goals,
        "judge_goal",
        lambda *a, **k: ("done", "looks done", False, None, False),
    )
    monkeypatch.setattr(goals, "verify_completion", lambda *a, **k: next(outcomes))

    mgr = goals.GoalManager(session_id="verifier-reset-sid")
    mgr.set("ship it")

    first = mgr.evaluate_after_turn("done, trust me")
    assert first["should_continue"], "an unverified claim must keep working"
    assert mgr.state.verify_downgrades == 1

    second = mgr.evaluate_after_turn("done, here are the passing tests")
    assert second["status"] == "done"
    assert mgr.state.verify_downgrades == 0, "a verified DONE must clear the streak"
