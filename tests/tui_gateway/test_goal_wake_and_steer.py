"""Gateway-side goal lifecycle parity: autonomous wake + mid-goal steering.

Two defects this file pins down:

1. **Wake parity.** ``GoalManager.poll_wake()`` clears a satisfied wait
   barrier and returns the continuation prompt so a parked goal advances
   with no user message. ``cli.py`` calls it from its idle drain loop;
   the gateway (desktop/TUI backend) never did — so a goal parked on a
   background process stayed parked forever in the Desktop app even after
   the barrier cleared. The notification poller is the gateway's analogue
   of the CLI idle loop, so the wake probe belongs beside the /loop tick.

2. **Steer durability.** A steer sent during an active goal only mutated
   the live turn. The continuation prompt is rebuilt from stored goal
   state each cycle, so the correction evaporated at the next judge
   boundary and the loop resumed chasing the original wording. Steers
   now persist on ``GoalState.steers`` and render into every subsequent
   continuation prompt.
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


def _call(server, method, **params):
    handler = server._methods[method]
    return handler(1, params)


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


# ── 2. /goal steer ────────────────────────────────────────────────────


def test_steer_persists_into_the_continuation_prompt(server, session):
    """The steer must survive the judge boundary, not just the live turn."""
    sid, session_key, s = session
    from hermes_cli.goals import GoalManager

    mgr = GoalManager(session_id=session_key)
    mgr.set("refactor the parser")

    r = _call(
        server,
        "command.dispatch",
        name="goal",
        arg="steer prefer regex over a hand-rolled lexer",
        session_id=sid,
    )
    assert r["result"]["type"] == "exec"
    assert "prefer regex" in r["result"]["output"]

    # Reload from the DB — a fresh manager must see it.
    prompt = GoalManager(session_id=session_key).next_continuation_prompt()
    assert "prefer regex over a hand-rolled lexer" in prompt
    assert "refactor the parser" in prompt


def test_steer_works_while_a_turn_is_running(server, session):
    """Steering mid-run is the whole point — it must not be queued."""
    sid, session_key, s = session
    from hermes_cli.goals import GoalManager

    GoalManager(session_id=session_key).set("build it")
    s["running"] = True

    r = _call(
        server, "command.dispatch", name="goal",
        arg="steer stop touching the config files", session_id=sid,
    )

    assert r["result"]["type"] == "exec"
    # Must NOT be swallowed by the pending_goal mid-run queue path.
    assert not s.get("pending_goal")
    prompt = GoalManager(session_id=session_key).next_continuation_prompt()
    assert "stop touching the config files" in prompt


def test_multiple_steers_accumulate_in_order(server, session):
    sid, session_key, s = session
    from hermes_cli.goals import GoalManager

    GoalManager(session_id=session_key).set("ship the feature")
    for text in ("use pytest not unittest", "keep the public API stable"):
        _call(server, "command.dispatch", name="goal",
              arg=f"steer {text}", session_id=sid)

    prompt = GoalManager(session_id=session_key).next_continuation_prompt()
    assert prompt.index("use pytest not unittest") < prompt.index(
        "keep the public API stable"
    )


def test_steer_requires_an_active_goal(server, session):
    sid, _, _ = session
    r = _call(server, "command.dispatch", name="goal",
              arg="steer do something else", session_id=sid)
    assert "No active goal" in r["result"]["output"]


def test_steer_clear_drops_accumulated_steers(server, session):
    sid, session_key, s = session
    from hermes_cli.goals import GoalManager

    GoalManager(session_id=session_key).set("do the work")
    _call(server, "command.dispatch", name="goal",
          arg="steer avoid the network", session_id=sid)
    _call(server, "command.dispatch", name="goal",
          arg="steer clear", session_id=sid)

    prompt = GoalManager(session_id=session_key).next_continuation_prompt()
    assert "avoid the network" not in prompt


def test_steer_is_not_mistaken_for_a_new_goal(server, session):
    """`steer` is a control verb — it must never replace the goal text."""
    sid, session_key, s = session
    from hermes_cli.goals import GoalManager

    GoalManager(session_id=session_key).set("original objective")
    _call(server, "command.dispatch", name="goal",
          arg="steer a course correction", session_id=sid)

    assert GoalManager(session_id=session_key).state.goal == "original objective"


def test_steer_reaches_the_live_agent_when_a_turn_is_running(server, session):
    """A steer sent mid-turn should hit the running turn too, not only the
    next continuation — and the reply must not claim a live effect that
    didn't happen."""
    sid, session_key, s = session
    from unittest.mock import MagicMock

    from hermes_cli.goals import GoalManager

    GoalManager(session_id=session_key).set("build it")
    s["running"] = True
    agent = MagicMock()
    agent.steer.return_value = True
    s["agent"] = agent

    r = _call(server, "command.dispatch", name="goal",
              arg="steer use the cached parser", session_id=sid)

    agent.steer.assert_called_once_with("use the cached parser")
    assert "running turn" in r["result"]["output"]
    # Still durable regardless of the live hand-off.
    prompt = GoalManager(session_id=session_key).next_continuation_prompt()
    assert "use the cached parser" in prompt


def test_steer_stays_durable_when_the_live_handoff_fails(server, session):
    """A broken/absent agent.steer must not lose the persisted correction,
    and the reply must not overpromise."""
    sid, session_key, s = session
    from unittest.mock import MagicMock

    from hermes_cli.goals import GoalManager

    GoalManager(session_id=session_key).set("build it")
    s["running"] = True
    agent = MagicMock()
    agent.steer.side_effect = RuntimeError("no steer buffer")
    s["agent"] = agent

    r = _call(server, "command.dispatch", name="goal",
              arg="steer avoid the network", session_id=sid)

    assert "running turn" not in r["result"]["output"]
    prompt = GoalManager(session_id=session_key).next_continuation_prompt()
    assert "avoid the network" in prompt


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


def test_steers_survive_a_contract_goal(server, session):
    """Contract goals take the contract template — steers must still render."""
    sid, session_key, s = session
    from hermes_cli.goals import GoalContract, GoalManager

    mgr = GoalManager(session_id=session_key)
    mgr.set("ship it")
    mgr.set_contract(GoalContract(outcome="tests green", verification="pytest"))

    _call(server, "command.dispatch", name="goal",
          arg="steer do not touch CI config", session_id=sid)

    prompt = GoalManager(session_id=session_key).next_continuation_prompt()
    assert "do not touch CI config" in prompt
    assert "tests green" in prompt
