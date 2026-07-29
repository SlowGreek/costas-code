"""A user message must preempt an auto-dispatched goal continuation.

Regression for the reported bug: with ``display.busy_input_mode: steer`` and an
active ``/goal``, answering the agent's question did nothing. Messages appeared
ABOVE the agent's message instead of below, the goal kept "running" with no
visible progress, and the only escape was pressing stop and resending.

The mechanism:

1. The agent finishes and asks the user a question. The judge returns
   ``blocked`` (it needs the user), so the goal stops.
2. The user's reply auto-unblocks the goal — correct — and runs as a turn.
3. At the end of THAT turn the judge says ``continue``, so the gateway
   auto-dispatches a goal continuation and ``session["running"]`` goes True
   again with no user prompt behind it.
4. The user's next message now lands mid-turn and hits the busy path. In
   ``steer`` mode it is stashed via ``agent.steer()`` to be glued onto the next
   TOOL RESULT — so it never becomes a user message. It renders attached to
   earlier content ("above") and the agent never answers it.

A steer is the right behavior for a turn the USER started: they are refining
work already in flight. It is the wrong behavior for a turn the GOAL LOOP
started on its own — the user is not refining that turn, they are answering a
question or redirecting the loop, and their message must become a real turn.
"""

from __future__ import annotations

import importlib
import threading
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


def _session(**extra):
    s = {
        "session_key": "goal-preempt-key",
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": True,
        "attached_images": [],
        "cols": 120,
    }
    s.update(extra)
    return s


class _SteerAgent:
    """Agent that records steers and redirects instead of performing them."""

    def __init__(self):
        self.steered: list[str] = []
        self.redirected: list[str] = []
        self.interrupted = False
        # Advertise redirect support so `interrupt` mode would prefer it —
        # the preempt path must win over BOTH steer and redirect.
        self._supports_active_turn_redirect = True

    def steer(self, text: str) -> bool:
        self.steered.append(text)
        return True

    def redirect(self, text) -> bool:
        self.redirected.append(text)
        return True

    def interrupt(self) -> None:
        self.interrupted = True


def test_user_message_preempts_a_goal_continuation_instead_of_steering(server):
    """The core contract: a goal-continuation turn does not absorb steers.

    Without this the user's answer is stashed for a tool result that may never
    come, so the reply is silently swallowed.
    """
    agent = _SteerAgent()
    session = _session(agent=agent, _goal_continuation=True)
    server._sessions["sid-goal"] = session

    with patch.object(server, "_load_busy_input_mode", return_value="steer"), patch.object(
        server, "_interrupt_busy_session", lambda *a, **k: None
    ):
        result = server._handle_busy_submit(
            1, "sid-goal", session, "yes, commit and push", None
        )

    assert agent.steered == [], "a goal continuation must not absorb the user's reply as a steer"
    assert agent.redirected == [], "a goal continuation must not absorb the user's reply as a redirect"
    assert result is not None
    assert result["result"]["status"] == "queued", (
        "the reply must be queued as a real turn so it runs after the "
        f"continuation stops; got {result['result']}"
    )


def test_user_message_still_steers_a_normal_user_turn(server):
    """Guard the feature the fix must not destroy.

    Steering a turn the USER started is the whole point of busy_input_mode=steer
    (the user's stated preference). Only goal-loop continuations are exempt.
    """
    agent = _SteerAgent()
    session = _session(agent=agent)  # no _goal_continuation marker
    server._sessions["sid-user"] = session

    with patch.object(server, "_load_busy_input_mode", return_value="steer"):
        result = server._handle_busy_submit(1, "sid-user", session, "also add tests", None)

    assert agent.steered == ["also add tests"], "a normal user turn must still steer"
    assert result is not None
    assert result["result"]["status"] == "steered"


def test_goal_continuation_marker_is_cleared_after_the_turn(server):
    """The marker is per-turn state, not sticky.

    If it survived the continuation, every later user turn would refuse to
    steer — silently disabling the user's configured busy_input_mode.
    """
    agent = _SteerAgent()
    session = _session(agent=agent, _goal_continuation=True, running=False)
    server._sessions["sid-clear"] = session

    server._clear_goal_continuation(session)
    assert not session.get("_goal_continuation")

    # With the marker gone, steering works again.
    session["running"] = True
    with patch.object(server, "_load_busy_input_mode", return_value="steer"):
        result = server._handle_busy_submit(1, "sid-clear", session, "next thing", None)

    assert agent.steered == ["next thing"]
    assert result["result"]["status"] == "steered"


def test_preempt_is_independent_of_busy_mode(server):
    """`interrupt` mode redirects in place, which has the same swallowing
    problem for a goal continuation: the correction rewrites a turn the user
    never asked for. Preempt must win regardless of the configured mode."""
    agent = _SteerAgent()
    session = _session(agent=agent, _goal_continuation=True)
    server._sessions["sid-mode"] = session

    with patch.object(server, "_load_busy_input_mode", return_value="interrupt"), patch.object(
        server, "_interrupt_busy_session", lambda *a, **k: None
    ):
        result = server._handle_busy_submit(1, "sid-mode", session, "stop, do X instead", None)

    assert agent.redirected == []
    assert agent.steered == []
    assert result["result"]["status"] == "queued"
