"""Tests for CLI goal-continuation interrupt handling.

Covers:
- Ctrl+C during a /goal turn auto-pauses the goal (no more continuations).
- Empty/whitespace-only responses skip the judge (no phantom continuations).
- Clean response without interrupt still drives the judge + enqueues.

These tests exercise ``_maybe_continue_goal_after_turn`` directly on a
minimal ``HermesCLI`` stub (pattern used elsewhere in tests/cli).
"""

from __future__ import annotations

import queue
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ──────────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────────


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    """Isolated HERMES_HOME so SessionDB.state_meta writes stay hermetic."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))

    # Bust the goal module's DB cache so it re-resolves HERMES_HOME each test.
    from hermes_cli import goals
    goals._DB_CACHE.clear()
    yield home
    goals._DB_CACHE.clear()


def _make_cli_with_goal(session_id: str, goal_text: str = "build a thing"):
    """Build a minimal HermesCLI stub with an active goal wired in."""
    from cli import HermesCLI
    from hermes_cli.goals import GoalManager

    cli = HermesCLI.__new__(HermesCLI)
    # State the hook + helpers touch directly.
    cli._pending_input = queue.Queue()
    cli._last_turn_interrupted = False
    cli.conversation_history = []
    # `_get_goal_manager()` reads `self.session_id` directly, not
    # `self.agent.session_id`. Match the production lookup.
    cli.session_id = session_id
    cli.agent = MagicMock()
    cli.agent.session_id = session_id

    mgr = GoalManager(session_id=session_id, default_max_turns=5)
    mgr.set(goal_text)
    cli._goal_manager = mgr
    return cli, mgr


# ──────────────────────────────────────────────────────────────────────
# Tests
# ──────────────────────────────────────────────────────────────────────


class TestInterruptAutoPause:
    def test_interrupted_turn_pauses_goal_and_skips_continuation(self, hermes_home):
        """Ctrl+C mid-turn must auto-pause the goal, not queue another round."""
        sid = f"sid-interrupt-{uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid)
        # Simulate an interrupted turn with a partial assistant reply.
        cli._last_turn_interrupted = True
        cli.conversation_history = [
            {"role": "user", "content": "kickoff"},
            {"role": "assistant", "content": "starting work..."},
        ]

        # Judge MUST NOT run on an interrupted turn. If it does, we've
        # regressed — fail loudly instead of silently querying a mock.
        with patch("hermes_cli.goals.judge_goal") as judge_mock:
            judge_mock.side_effect = AssertionError(
                "judge_goal called on an interrupted turn"
            )
            cli._maybe_continue_goal_after_turn()

        # Pending input must NOT contain a continuation prompt.
        assert cli._pending_input.empty(), (
            "Interrupted turn should not enqueue a continuation prompt"
        )

        # Goal should be paused, not active.
        state = mgr.state
        assert state is not None
        assert state.status == "paused"
        assert "interrupt" in (state.paused_reason or "").lower()

    def test_interrupted_turn_is_resumable(self, hermes_home):
        """After auto-pause from Ctrl+C, /goal resume puts it back to active."""
        sid = f"sid-resume-{uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid)
        cli._last_turn_interrupted = True
        cli.conversation_history = [
            {"role": "assistant", "content": "partial"},
        ]
        with patch("hermes_cli.goals.judge_goal"):
            cli._maybe_continue_goal_after_turn()
        assert mgr.state.status == "paused"

        mgr.resume()
        assert mgr.state.status == "active"


class TestEmptyResponseSkip:
    def test_empty_response_does_not_invoke_judge(self, hermes_home):
        """Whitespace-only replies skip judging (transient failure guard)."""
        sid = f"sid-empty-{uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid)
        cli._last_turn_interrupted = False
        cli.conversation_history = [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": "   \n\n   "},
        ]

        with patch("hermes_cli.goals.judge_goal") as judge_mock:
            judge_mock.side_effect = AssertionError(
                "judge_goal called on an empty response"
            )
            cli._maybe_continue_goal_after_turn()

        # No continuation queued; goal still active (neither paused nor done).
        assert cli._pending_input.empty()
        assert mgr.state.status == "active"

    def test_no_assistant_message_skipped(self, hermes_home):
        """Conversation with zero assistant replies must not trip the judge."""
        sid = f"sid-noassistant-{uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid)
        cli._last_turn_interrupted = False
        cli.conversation_history = [
            {"role": "user", "content": "go"},
        ]

        with patch("hermes_cli.goals.judge_goal") as judge_mock:
            judge_mock.side_effect = AssertionError(
                "judge_goal called without an assistant response"
            )
            cli._maybe_continue_goal_after_turn()

        assert cli._pending_input.empty()
        assert mgr.state.status == "active"


class TestHealthyTurnStillRuns:
    def test_clean_response_enqueues_continuation_when_judge_says_continue(
        self, hermes_home,
    ):
        """Sanity check: the hook still works in the happy path."""
        sid = f"sid-healthy-{uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid)
        cli._last_turn_interrupted = False
        cli.conversation_history = [
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": "did some work, more to do"},
        ]

        # Force the judge to say "continue" without touching the network.
        with patch(
            "hermes_cli.goals.judge_goal",
            return_value=("continue", "needs more steps", False, None, False),
        ):
            cli._maybe_continue_goal_after_turn()

        # Continuation prompt must be queued.
        assert not cli._pending_input.empty()
        queued = cli._pending_input.get_nowait()
        assert "Continuing toward your standing goal" in queued
        assert mgr.state.status == "active"

    def test_clean_response_marks_done_when_judge_says_done(self, hermes_home):
        sid = f"sid-done-{uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid)
        cli._last_turn_interrupted = False
        cli.conversation_history = [
            {"role": "assistant", "content": "all finished, here's the result"},
        ]

        with patch(
            "hermes_cli.goals.judge_goal",
            return_value=("done", "goal satisfied", False, None, False),
        ):
            cli._maybe_continue_goal_after_turn()

        assert cli._pending_input.empty()
        assert mgr.state.status == "done"


class TestInterruptFlagLifecycle:
    def test_chat_resets_flag_at_entry(self, hermes_home):
        """chat() must reset _last_turn_interrupted at the top of each turn.

        This guards against stale flag state: if turn N was interrupted and
        turn N+1 runs clean, the hook must not see True from N.
        """
        # We can't run chat() end-to-end here, but we can assert the reset
        # is the first thing after the secret-capture registration by
        # inspecting the source shape.
        from cli import HermesCLI
        import inspect

        src = inspect.getsource(HermesCLI.chat)
        # Look for an explicit reset near the top of chat().
        head = src.split("if not self._ensure_runtime_credentials", 1)[0]
        assert "self._last_turn_interrupted = False" in head, (
            "chat() must reset _last_turn_interrupted before run_conversation "
            "runs — otherwise a prior turn's interrupt state leaks into the "
            "next turn's goal hook decision."
        )


# ──────────────────────────────────────────────────────────────────────
# Phase 1 — scoped background evidence, autonomous wake, queued-user
# preemption (behavioral, on the real _maybe_continue_goal_after_turn).
# ──────────────────────────────────────────────────────────────────────


class TestScopedBackgroundEvidence:
    def test_gather_scoped_to_session(self, hermes_home):
        """The CLI must scope background-process gathering to its own session
        so the judge never sees another session's jobs."""
        import uuid as _uuid

        sid = f"sid-scope-{_uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid)
        cli.conversation_history = [
            {"role": "assistant", "content": "did some work, more to go"},
        ]

        captured = {}

        def _fake_gather(task_id=None, session_key=None):
            captured["session_key"] = session_key
            return []

        with patch("hermes_cli.goals.gather_background_processes", side_effect=_fake_gather), patch(
            "hermes_cli.goals.judge_goal",
            return_value=("continue", "keep going", False, None, False),
        ):
            cli._maybe_continue_goal_after_turn()

        assert captured.get("session_key") == sid


class TestAutonomousWakeCLI:
    def test_idle_wake_enqueues_continuation_after_deadline(self, hermes_home):
        import time
        import uuid as _uuid

        sid = f"sid-wake-{_uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid, goal_text="finish the report")
        mgr.wait_for_seconds(120, reason="backoff")
        # Force the deadline into the past → idle wake should fire.
        mgr.state.waiting_until = time.time() - 1

        cli._maybe_wake_parked_goal()

        assert not cli._pending_input.empty()
        queued = cli._pending_input.get_nowait()
        assert "finish the report" in queued

    def test_idle_wake_noop_while_parked(self, hermes_home):
        import uuid as _uuid

        sid = f"sid-wake2-{_uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid)
        mgr.wait_for_seconds(120, reason="backoff")

        cli._maybe_wake_parked_goal()
        assert cli._pending_input.empty()  # still parked, nothing enqueued


class TestQueuedUserPreemption:
    def test_real_user_message_preempts_without_judging_or_consuming_turn(self, hermes_home):
        """A queued real user message must preempt the continuation without
        calling the judge or consuming a goal turn."""
        import uuid as _uuid

        sid = f"sid-preempt-{_uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid)
        cli.conversation_history = [
            {"role": "assistant", "content": "did work"},
        ]
        cli._pending_input.put("actually, do this other thing")  # real user message

        with patch(
            "hermes_cli.goals.judge_goal",
            side_effect=AssertionError("judge must not run when a real user message is queued"),
        ):
            cli._maybe_continue_goal_after_turn()

        # The user's message is still queued (not displaced), no continuation
        # stacked on top, and no goal turn consumed.
        assert cli._pending_input.qsize() == 1
        assert mgr.state.turns_used == 0
        assert mgr.state.status == "active"

    def test_queued_slash_command_does_not_preempt(self, hermes_home):
        """A queued slash command is NOT a real user message — the goal loop
        still judges and continues."""
        import uuid as _uuid

        sid = f"sid-preempt2-{_uuid.uuid4().hex}"
        cli, mgr = _make_cli_with_goal(sid)
        cli.conversation_history = [
            {"role": "assistant", "content": "did work"},
        ]
        cli._pending_input.put("/subgoal add more tests")  # slash command, not real msg

        with patch("hermes_cli.goals.gather_background_processes", return_value=[]), patch(
            "hermes_cli.goals.judge_goal",
            return_value=("continue", "keep going", False, None, False),
        ):
            cli._maybe_continue_goal_after_turn()

        # Judge ran and a continuation was stacked after the slash command.
        assert mgr.state.turns_used == 1
