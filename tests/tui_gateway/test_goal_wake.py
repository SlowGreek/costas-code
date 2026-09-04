"""Gateway-side autonomous goal-wake parity with the CLI.

``GoalManager.poll_wake()`` clears a satisfied wait
   barrier and returns the continuation prompt so a parked goal advances
   with no user message. ``cli.py`` calls it from its idle drain loop;
   the gateway (desktop/TUI backend) never did — so a goal parked on a
   background process stayed parked forever in the Desktop app even after
   the barrier cleared. The notification poller is the gateway's analogue
   of the CLI idle loop, so the wake probe belongs beside the /loop tick.
"""

from __future__ import annotations

import importlib
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture()
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))

    from hermes_cli import goals

    goals._DB_CACHE.clear()
    yield home
    goals._DB_CACHE.clear()


@pytest.fixture()
def server(hermes_home):
    with patch.dict(
        "sys.modules",
        {
            "hermes_cli.env_loader": MagicMock(),
            "hermes_cli.banner": MagicMock(),
        },
    ):
        mod = importlib.import_module("tui_gateway.server")
        yield mod
        mod._sessions.clear()
        mod._pending.clear()
        mod._answers.clear()


@pytest.fixture()
def session(server):
    sid = "sid-goal-wake-test"
    session_key = "tui-goal-wake-session-1"
    s = {
        "session_key": session_key,
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": False,
        "attached_images": [],
        "cols": 120,
    }
    server._sessions[sid] = s
    return sid, session_key, s


# ── 1. autonomous wake parity with the CLI ────────────────────────────


def test_gateway_wakes_goal_once_park_deadline_passes(server, session):
    """The exact defect: parked goal, expired ceiling, no user message."""
    sid, session_key, s = session
    from hermes_cli.goals import GoalManager, save_goal

    mgr = GoalManager(session_id=session_key)
    mgr.set("verify the build and iterate")
    mgr.wait_for_seconds(600, reason="CI still running")
    mgr.state.waiting_until = time.time() - 1  # ceiling elapsed
    save_goal(session_key, mgr.state)

    fired = {}

    def fake_submit(rid, sid_, session_, text, **kwargs):
        fired["text"] = text

    with patch.object(server, "_run_prompt_submit", fake_submit), \
         patch.object(server, "_emit"):
        server._maybe_wake_parked_goal(sid, s)

    assert "verify the build and iterate" in fired.get("text", "")
    assert s["running"] is True
    # Barrier cleared in the DB, not just in memory.
    assert GoalManager(session_id=session_key).is_waiting() is False


def test_gateway_leaves_goal_parked_while_barrier_holds(server, session):
    sid, session_key, s = session
    from hermes_cli.goals import GoalManager, save_goal

    mgr = GoalManager(session_id=session_key)
    mgr.set("wait for CI")
    mgr.wait_for_seconds(600, reason="CI still running")
    save_goal(session_key, mgr.state)

    with patch.object(server, "_run_prompt_submit") as submit, \
         patch.object(server, "_emit"):
        server._maybe_wake_parked_goal(sid, s)

    submit.assert_not_called()
    assert GoalManager(session_id=session_key).is_waiting() is True


def test_gateway_wake_defers_when_session_busy(server, session):
    """A racing user turn wins; the goal stays parked and retries next poll."""
    sid, session_key, s = session
    from hermes_cli.goals import GoalManager, save_goal

    mgr = GoalManager(session_id=session_key)
    mgr.set("do the thing")
    mgr.wait_for_seconds(600)
    mgr.state.waiting_until = time.time() - 1
    save_goal(session_key, mgr.state)
    s["running"] = True

    with patch.object(server, "_run_prompt_submit") as submit, \
         patch.object(server, "_emit"):
        server._maybe_wake_parked_goal(sid, s)

    submit.assert_not_called()
    # Not consumed: a later poll (once the user's turn ends) must still find
    # the wake available. Asserting via is_waiting() would be self-defeating —
    # it lazily clears an expired ceiling as a side effect of being called.
    assert GoalManager(session_id=session_key).poll_wake() is not None


def test_gateway_wake_noop_without_goal(server, session):
    sid, _, s = session
    with patch.object(server, "_run_prompt_submit") as submit, \
         patch.object(server, "_emit"):
        server._maybe_wake_parked_goal(sid, s)
    submit.assert_not_called()


def test_notification_poller_polls_the_goal_wake(server):
    """Wake must run on the gateway's existing idle loop, not a new thread."""
    import inspect

    src = inspect.getsource(server._notification_poller_loop)
    assert "_maybe_wake_parked_goal" in src


def test_gateway_wake_does_not_fire_for_a_cleared_goal(server, session):
    """A user /goal clear that lands while the poller holds the claim must
    suppress the continuation — firing one for a goal that no longer exists
    is worse than a missed wake."""
    sid, session_key, s = session
    from hermes_cli.goals import GoalManager, save_goal

    mgr = GoalManager(session_id=session_key)
    mgr.set("something the user abandoned")
    mgr.wait_for_seconds(600)
    mgr.state.waiting_until = time.time() - 1
    save_goal(session_key, mgr.state)

    real_poll = GoalManager.poll_wake

    def poll_then_clear(self):
        prompt = real_poll(self)
        # Simulate the racing `/goal clear` landing right here.
        GoalManager(session_id=session_key).clear()
        return prompt

    with patch.object(GoalManager, "poll_wake", poll_then_clear), \
         patch.object(server, "_run_prompt_submit") as submit, \
         patch.object(server, "_emit"):
        server._maybe_wake_parked_goal(sid, s)

    submit.assert_not_called()
    # And the claim must be released, not leaked.
    assert s["running"] is False


def test_gateway_wake_releases_the_claim_when_still_parked(server, session):
    """Claiming before probing must not leak running=True on the no-op path."""
    sid, session_key, s = session
    from hermes_cli.goals import GoalManager, save_goal

    mgr = GoalManager(session_id=session_key)
    mgr.set("wait for CI")
    mgr.wait_for_seconds(600, reason="still running")
    save_goal(session_key, mgr.state)

    with patch.object(server, "_run_prompt_submit") as submit, \
         patch.object(server, "_emit"):
        server._maybe_wake_parked_goal(sid, s)

    submit.assert_not_called()
    assert s["running"] is False
