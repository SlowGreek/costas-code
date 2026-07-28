"""Tests for /goal handling in tui_gateway.

The TUI routes ``/goal`` through ``command.dispatch`` (not ``slash.exec``)
because the CLI's ``_handle_goal_command`` queues the kickoff message onto
``_pending_input``, which the slash-worker subprocess has no reader for.
Instead we handle ``/goal`` directly in the server and return a
``{"type": "send", "notice": ..., "message": ...}`` payload the TUI client
uses to render a system line and fire the kickoff prompt.
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

    # Bust the goal-module DB cache so it re-resolves HERMES_HOME.
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
        # Reset module-level session state without re-importing. importlib.reload
        # would re-register the module's atexit hooks (ThreadPoolExecutor
        # shutdown, _shutdown_sessions); the duplicates race the stderr
        # buffer at interpreter shutdown and surface as Fatal Python error:
        # _enter_buffered_busy. Clearing the per-session dicts gives the
        # next test a clean slate; _methods is NOT cleared because it's
        # populated at module import time and re-registration only happens
        # via reload (which we don't do).
        mod._sessions.clear()
        mod._pending.clear()
        mod._answers.clear()


@pytest.fixture()
def session(server):
    sid = "sid-test"
    session_key = "tui-goal-session-1"
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


# ── command.dispatch /goal ────────────────────────────────────────────


def test_goal_bare_shows_status_when_none_set(server, session):
    sid, _, _ = session
    r = _call(server, "command.dispatch", name="goal", arg="", session_id=sid)
    assert r["result"]["type"] == "exec"
    assert "No active goal" in r["result"]["output"]


def test_goal_whitespace_only_shows_status(server, session):
    sid, _, _ = session
    r = _call(server, "command.dispatch", name="goal", arg="   ", session_id=sid)
    assert r["result"]["type"] == "exec"
    assert "No active goal" in r["result"]["output"]


def test_goal_status_alias_shows_status(server, session):
    sid, _, _ = session
    r = _call(server, "command.dispatch", name="goal", arg="status", session_id=sid)
    assert r["result"]["type"] == "exec"
    assert "No active goal" in r["result"]["output"]


def test_goal_set_returns_send_with_notice(server, session):
    sid, session_key, _ = session
    r = _call(server, "command.dispatch", name="goal", arg="build a rocket", session_id=sid)
    result = r["result"]
    assert result["type"] == "send"
    assert result["message"] == "build a rocket"
    assert "notice" in result
    assert "Goal set" in result["notice"]
    assert "20-turn budget" in result["notice"]

    # Persisted in SessionDB
    from hermes_cli.goals import GoalManager

    mgr = GoalManager(session_key)
    assert mgr.state is not None
    assert mgr.state.goal == "build a rocket"
    assert mgr.state.status == "active"


def test_goal_status_rpc_returns_structured_state(server, session):
    sid, _, _ = session
    _call(server, "command.dispatch", name="goal", arg="ship the release", session_id=sid)

    r = _call(server, "goal.status", session_id=sid)

    assert r["result"]["goal"] == {
        "goal": "ship the release",
        "status": "active",
        "turns_used": 0,
        "max_turns": 20,
        "last_reason": None,
        "paused_reason": None,
        "blocked_reason": None,
        "waiting_reason": None,
    }


def test_goal_status_rpc_returns_none_after_clear(server, session):
    sid, _, _ = session
    _call(server, "command.dispatch", name="goal", arg="ship the release", session_id=sid)
    _call(server, "command.dispatch", name="goal", arg="clear", session_id=sid)

    r = _call(server, "goal.status", session_id=sid)

    assert r["result"]["goal"] is None


def test_goal_pause_after_set(server, session):
    sid, session_key, _ = session
    _call(server, "command.dispatch", name="goal", arg="write a story", session_id=sid)
    r = _call(server, "command.dispatch", name="goal", arg="pause", session_id=sid)
    assert r["result"]["type"] == "exec"
    assert "paused" in r["result"]["output"].lower()

    from hermes_cli.goals import GoalManager

    assert GoalManager(session_key).state.status == "paused"


def test_goal_resume_reactivates(server, session):
    sid, session_key, _ = session
    _call(server, "command.dispatch", name="goal", arg="write a story", session_id=sid)
    _call(server, "command.dispatch", name="goal", arg="pause", session_id=sid)
    r = _call(server, "command.dispatch", name="goal", arg="resume", session_id=sid)
    assert r["result"]["type"] == "exec"
    assert "resumed" in r["result"]["output"].lower()

    from hermes_cli.goals import GoalManager

    assert GoalManager(session_key).state.status == "active"


def test_goal_clear_removes_active_goal(server, session):
    sid, session_key, _ = session
    _call(server, "command.dispatch", name="goal", arg="write a story", session_id=sid)
    r = _call(server, "command.dispatch", name="goal", arg="clear", session_id=sid)
    assert r["result"]["type"] == "exec"
    assert "cleared" in r["result"]["output"].lower()

    from hermes_cli.goals import GoalManager

    # After clear the row is marked status=cleared (kept for audit);
    # ``has_goal()`` / ``is_active()`` return False so the goal loop
    # stays off and ``status`` reports "No active goal".
    mgr = GoalManager(session_key)
    assert not mgr.has_goal()
    assert not mgr.is_active()
    assert "No active goal" in mgr.status_line()


def test_goal_stop_and_done_are_clear_aliases(server, session):
    sid, _, _ = session
    _call(server, "command.dispatch", name="goal", arg="first goal", session_id=sid)
    r = _call(server, "command.dispatch", name="goal", arg="stop", session_id=sid)
    assert "cleared" in r["result"]["output"].lower()

    _call(server, "command.dispatch", name="goal", arg="second goal", session_id=sid)
    r = _call(server, "command.dispatch", name="goal", arg="done", session_id=sid)
    assert "cleared" in r["result"]["output"].lower()


def test_goal_requires_session(server):
    r = _call(server, "command.dispatch", name="goal", arg="nope", session_id="unknown")
    assert "error" in r
    assert r["error"]["code"] == 4001


# ── slash.exec /goal routing ──────────────────────────────────────────


def test_slash_exec_routes_goal_to_command_dispatch(server, session):
    """slash.exec must route /goal directly to command.dispatch internally
    instead of returning an error.  Previously the 4018 error required the
    TUI client to retry via command.dispatch, but some clients failed the
    fallback, leaving the command empty ("empty command")."""
    sid, _, _ = session
    r = _call(server, "slash.exec", command="goal status", session_id=sid)
    # Should succeed by routing to command.dispatch internally
    assert "result" in r
    assert r["result"]["type"] == "exec"
    assert "No active goal" in r["result"]["output"]


def test_pending_input_commands_includes_goal(server):
    """Guard: _PENDING_INPUT_COMMANDS must list 'goal' — removing it would
    silently re-break the TUI."""
    assert "goal" in server._PENDING_INPUT_COMMANDS


# ── command.dispatch /moa ────────────────────────────────────────────

def _write_moa_config(home, text):
    cfg_path = home / "config.yaml"
    cfg_path.write_text(text)


def test_moa_bare_returns_usage(server, session, hermes_home):
    _write_moa_config(hermes_home, """
moa:
  default_preset: default
  presets:
    default:
      reference_models:
        - provider: openai-codex
          model: gpt-5.5
      aggregator:
        provider: openrouter
        model: anthropic/claude-opus-4.8
""")
    sid, _, s = session
    r = _call(server, "command.dispatch", name="moa", arg="", session_id=sid)
    # Bare /moa is usage-only now; switching to a preset is via the model picker.
    assert "error" in r
    assert "model_override" not in s


def test_moa_arg_is_always_one_shot(server, session, hermes_home):
    # Any arg (even a preset name) is a one-shot prompt through the DEFAULT
    # preset; /moa never does a sticky switch anymore.
    _write_moa_config(hermes_home, """
moa:
  default_preset: default
  presets:
    default: {}
    review:
      reference_models:
        - provider: openrouter
          model: deepseek/deepseek-v4-pro
      aggregator:
        provider: openrouter
        model: anthropic/claude-opus-4.8
""")
    sid, _, s = session
    r = _call(server, "command.dispatch", name="moa", arg="review", session_id=sid)
    result = r["result"]
    assert result["type"] == "send"
    assert result["message"] == "review"
    assert "one-shot" in result["notice"]
    # Lazy session (no live agent) → MoA preset pinned via model_override for
    # the build, and it is the DEFAULT preset, not the "review" arg.
    assert s["model_override"]["provider"] == "moa"
    assert s["model_override"]["model"] == "default"


def test_moa_non_preset_returns_one_shot_send(server, session, hermes_home):
    _write_moa_config(hermes_home, """
moa:
  default_preset: default
  presets:
    default:
      reference_models:
        - provider: openai-codex
          model: gpt-5.5
      aggregator:
        provider: openrouter
        model: anthropic/claude-opus-4.8
""")
    sid, _, _ = session
    r = _call(server, "command.dispatch", name="moa", arg="inspect this project", session_id=sid)
    result = r["result"]
    assert result["type"] == "send"
    assert result["message"] == "inspect this project"
    assert "one-shot" in result["notice"]


def test_pending_input_commands_includes_moa(server):
    assert "moa" in server._PENDING_INPUT_COMMANDS


# ── /subgoal on the TUI (R6) ──────────────────────────────────────────


def test_pending_input_commands_includes_subgoal(server):
    """Guard: /subgoal must route through _PENDING_INPUT_COMMANDS so slash.exec
    dispatches it to command.dispatch (the slash worker has no _pending_input)."""
    assert "subgoal" in server._PENDING_INPUT_COMMANDS


def test_subgoal_requires_active_goal(server, session):
    sid, _, _ = session
    r = _call(server, "command.dispatch", name="subgoal", arg="write tests", session_id=sid)
    assert r["result"]["type"] == "exec"
    assert "No active goal" in r["result"]["output"]


def test_subgoal_add_list_and_remove(server, session):
    sid, session_key, _ = session
    _call(server, "command.dispatch", name="goal", arg="ship the feature", session_id=sid)

    # Add
    r = _call(server, "command.dispatch", name="subgoal", arg="write tests", session_id=sid)
    assert "Added subgoal 1" in r["result"]["output"]

    from hermes_cli.goals import GoalManager
    assert GoalManager(session_key).state.subgoals == ["write tests"]

    # List (bare)
    r = _call(server, "command.dispatch", name="subgoal", arg="", session_id=sid)
    assert "write tests" in r["result"]["output"]

    # Remove
    r = _call(server, "command.dispatch", name="subgoal", arg="remove 1", session_id=sid)
    assert "Removed subgoal 1" in r["result"]["output"]
    assert GoalManager(session_key).state.subgoals == []


def test_subgoal_clear(server, session):
    sid, session_key, _ = session
    _call(server, "command.dispatch", name="goal", arg="ship it", session_id=sid)
    _call(server, "command.dispatch", name="subgoal", arg="a", session_id=sid)
    _call(server, "command.dispatch", name="subgoal", arg="b", session_id=sid)
    r = _call(server, "command.dispatch", name="subgoal", arg="clear", session_id=sid)
    assert "Cleared 2" in r["result"]["output"]

    from hermes_cli.goals import GoalManager
    assert GoalManager(session_key).state.subgoals == []


# ── mid-run goal-set queueing (R6) ────────────────────────────────────


def test_goal_set_queued_while_running(server, session):
    """Setting a NEW goal during an active turn queues it instead of failing."""
    sid, session_key, s = session
    s["running"] = True
    r = _call(server, "command.dispatch", name="goal", arg="brand new goal", session_id=sid)
    assert r["result"]["type"] == "exec"
    assert "queued" in r["result"]["output"].lower()
    assert "brand new goal" in r["result"]["output"]

    # Parked on the session, not yet persisted — the running turn's judge must
    # not see it.
    assert s["pending_goal"] == "brand new goal"
    from hermes_cli.goals import GoalManager
    assert GoalManager(session_key).state is None


def test_goal_status_reports_queued_goal(server, session):
    sid, _, s = session
    s["running"] = True
    _call(server, "command.dispatch", name="goal", arg="queued objective", session_id=sid)

    r = _call(server, "command.dispatch", name="goal", arg="status", session_id=sid)
    assert "queued objective" in r["result"]["output"]


def test_goal_clear_drops_queued_goal(server, session):
    sid, session_key, s = session
    s["running"] = True
    _call(server, "command.dispatch", name="goal", arg="doomed goal", session_id=sid)

    r = _call(server, "command.dispatch", name="goal", arg="clear", session_id=sid)
    assert "cleared" in r["result"]["output"].lower()
    assert not s.get("pending_goal")

    from hermes_cli.goals import GoalManager
    assert GoalManager(session_key).state is None


def test_goal_pause_drops_queued_goal(server, session):
    sid, _, s = session
    s["running"] = True
    _call(server, "command.dispatch", name="goal", arg="doomed goal", session_id=sid)

    r = _call(server, "command.dispatch", name="goal", arg="pause", session_id=sid)
    assert "doomed goal" in r["result"]["output"]
    assert not s.get("pending_goal")


def test_drain_pending_goal_persists_and_dispatches(server, session, monkeypatch):
    """At turn end the queued goal is persisted and submitted as a real turn."""
    sid, session_key, s = session
    s["running"] = True
    _call(server, "command.dispatch", name="goal", arg="ship the feature", session_id=sid)

    # Turn finished.
    s["running"] = False
    submitted = []
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda rid, _sid, _session, text: submitted.append(text),
    )
    monkeypatch.setattr(server, "_emit", lambda *a, **k: None)

    assert server._drain_pending_goal(1, sid, s) is True
    assert submitted == ["ship the feature"]
    assert not s.get("pending_goal")

    from hermes_cli.goals import GoalManager
    state = GoalManager(session_key).state
    assert state is not None
    assert state.goal == "ship the feature"
    assert state.status == "active"


def test_drain_pending_goal_noop_when_nothing_queued(server, session):
    sid, _, s = session
    assert server._drain_pending_goal(1, sid, s) is False


def test_drain_pending_goal_skips_while_running(server, session):
    sid, _, s = session
    s["running"] = True
    _call(server, "command.dispatch", name="goal", arg="later", session_id=sid)
    # Still running (e.g. a queued user prompt claimed the session first).
    assert server._drain_pending_goal(1, sid, s) is False
    assert s["pending_goal"] == "later"


def test_goal_control_verbs_allowed_while_running(server, session):
    """Control verbs (status/pause/clear) stay allowed mid-run."""
    sid, session_key, s = session
    # Set a goal while idle, then flip to running.
    _call(server, "command.dispatch", name="goal", arg="ongoing goal", session_id=sid)
    s["running"] = True

    r = _call(server, "command.dispatch", name="goal", arg="status", session_id=sid)
    assert r["result"]["type"] == "exec"
    assert "ongoing goal" in r["result"]["output"]

    r = _call(server, "command.dispatch", name="goal", arg="pause", session_id=sid)
    assert "paused" in r["result"]["output"].lower()


# ── blocked status render (R1) ────────────────────────────────────────


def test_goal_blocked_status_is_honest(server, session):
    sid, session_key, _ = session
    _call(server, "command.dispatch", name="goal", arg="deploy prod", session_id=sid)

    from hermes_cli.goals import GoalManager
    GoalManager(session_key).mark_blocked("needs prod credentials")

    r = _call(server, "command.dispatch", name="goal", arg="status", session_id=sid)
    out = r["result"]["output"]
    assert "blocked" in out.lower()
    assert "achieved" not in out.lower()
    assert "✓ Goal done" not in out


# ── Fix 2: stale goal-continuation race (fresh fail-closed DB recheck) ──


def test_goal_active_in_db_true_for_active(server, session):
    sid, session_key, _ = session
    _call(server, "command.dispatch", name="goal", arg="ship it", session_id=sid)
    assert server._goal_active_in_db(session_key) is True


def test_stale_goal_continuation_suppressed_after_clear(server, session):
    """Deterministic race regression: a goal_followup decided while the goal
    was active must NOT fire if the user /goal clear persists an inactive state
    before dispatch. The dispatch guard re-reads the DB (fail-closed)."""
    sid, session_key, _ = session
    _call(server, "command.dispatch", name="goal", arg="ship it", session_id=sid)
    # goal_followup would have been decided here (goal active).
    assert server._goal_active_in_db(session_key) is True

    # User clears the goal in the window before dispatch (persists status=cleared).
    from hermes_cli.goals import GoalManager

    GoalManager(session_key).clear()

    # The fresh recheck the dispatch performs now returns False → stale
    # continuation is suppressed.
    assert server._goal_active_in_db(session_key) is False


def test_stale_goal_continuation_suppressed_after_pause(server, session):
    sid, session_key, _ = session
    _call(server, "command.dispatch", name="goal", arg="ship it", session_id=sid)
    from hermes_cli.goals import GoalManager

    GoalManager(session_key).pause()
    assert server._goal_active_in_db(session_key) is False


def test_goal_active_in_db_fail_closed_on_bad_key(server):
    assert server._goal_active_in_db("") is False
    assert server._goal_active_in_db("no-such-session") is False


# ── Fix 1: foreground tool evidence reaches the verifier (TUI source shape) ──


def test_tui_result_tool_evidence_reaches_verifier(server, session, hermes_home):
    """The TUI feeds real tool/test results from the turn's agent result
    (``result["messages"]``) into the second-stage verifier. Proven at the
    goals seam using the exact evidence source _run_prompt_submit uses (that
    function drives a full turn and isn't unit-testable, so we assert the data
    flow it now performs)."""
    sid, session_key, _ = session
    from hermes_cli.goals import GoalManager, GoalContract, extract_recent_tool_evidence

    mgr = GoalManager(session_key)
    mgr.set("ship it", contract=GoalContract(verification="pytest passes"))

    # A TUI-shaped agent result — what _run_prompt_submit receives from the turn.
    result = {
        "final_response": "All green — done.",
        "messages": [
            {"role": "tool", "name": "terminal", "content": "17 passed, 0 failed"},
            {"role": "assistant", "content": "done"},
        ],
    }
    evidence = extract_recent_tool_evidence(
        result.get("messages") if isinstance(result, dict) else None
    )
    assert any("17 passed" in e for e in evidence)

    captured = {}

    def _verifier(**kwargs):
        captured["user"] = " ".join(
            m.get("content", "") for m in kwargs.get("messages", []) if m.get("role") == "user"
        )

        class _M:
            content = '{"confirmed": true, "reason": "17 passed shown"}'

        class _C:
            message = _M()

        class _R:
            choices = [_C()]

        return _R()

    from hermes_cli import goals as _goals

    with patch.object(_goals, "judge_goal", return_value=("done", "looks done", False, None, False)), patch(
        "agent.auxiliary_client.call_llm", side_effect=_verifier
    ):
        decision = mgr.evaluate_after_turn(result["final_response"], recent_evidence=evidence)

    assert "17 passed" in (captured.get("user") or ""), "tool evidence must reach the verifier"
    assert decision["verdict"] == "done"


# ── auto-unblock on the next user prompt ──────────────────────────────


def test_prompt_submit_auto_unblocks_a_blocked_goal(server, session):
    """A blocked goal resumes when the user sends their next message.

    `blocked` means the agent needs the user; their prompt IS that input, so
    the gateway must flip it back to active BEFORE the turn runs — otherwise
    the end-of-turn judge sees an inactive goal and never chains a
    continuation, stranding the loop behind a manual /goal resume.
    """
    from hermes_cli.goals import GoalManager

    sid, session_key, s = session
    mgr = GoalManager(session_id=session_key)
    mgr.set("keep looping until it exports")
    mgr.state.turns_used = 2
    mgr.mark_blocked("SVG cannot pixel-match a raytraced reference.")

    emitted = []
    with patch.object(server, "_emit", lambda kind, _sid, payload=None: emitted.append((kind, payload))):
        server._auto_unblock_goal(sid, s)

    fresh = GoalManager(session_id=session_key)
    assert fresh.state.status == "active"
    assert fresh.is_active()
    assert fresh.state.blocked_reason is None
    # Answering a question continues the goal; it does not restart the budget.
    assert fresh.state.turns_used == 2
    assert any(p and p.get("kind") == "goal" for _k, p in emitted)


def test_auto_unblock_leaves_active_and_paused_goals_alone(server, session):
    """Only `blocked` auto-resumes: a user-paused goal must stay paused, and
    an active goal must not be disturbed (nor announce a spurious resume)."""
    from hermes_cli.goals import GoalManager

    sid, session_key, s = session
    mgr = GoalManager(session_id=session_key)
    mgr.set("ship it")
    mgr.pause(reason="user-paused")

    emitted = []
    with patch.object(server, "_emit", lambda kind, _sid, payload=None: emitted.append((kind, payload))):
        server._auto_unblock_goal(sid, s)

    assert GoalManager(session_id=session_key).state.status == "paused"
    assert emitted == []


def test_auto_unblock_is_fail_soft_without_a_session_key(server, session):
    """No session key (or a goals failure) must never break prompt.submit —
    the goal simply stays blocked, which is the honest state."""
    sid, _, _ = session
    server._auto_unblock_goal(sid, {"session_key": ""})
    server._auto_unblock_goal(sid, None)
