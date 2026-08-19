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
import types
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
def server(hermes_home, monkeypatch):
    # Mocks are scoped to the initial import only (see
    # tests/tui_gateway/test_protocol.py for the rationale).
    with patch.dict(
        "sys.modules",
        {
            "hermes_cli.env_loader": MagicMock(),
            "hermes_cli.banner": MagicMock(),
        },
    ):
        mod = importlib.import_module("tui_gateway.server")

    # Pin config resolution to the isolated HERMES_HOME. Sibling test
    # files (test_billing_rpc, test_delegation_session_lifecycle,
    # test_gateway_owned_session_reap, ...) import tui_gateway.server at
    # collection time — BEFORE the conftest env isolation runs — so the
    # module-level ``_hermes_home = get_hermes_home()`` snapshot freezes
    # the developer's real home. When any of them precede this file in
    # the same process, ``importlib.import_module`` returns that cached
    # module and ``_load_cfg()`` would read the REAL config.yaml (e.g. a
    # local MoA preset) instead of the one ``_write_moa_config`` writes.
    # Also reset the mtime-keyed config cache; monkeypatch restores the
    # originals on teardown so nothing leaks to later tests either.
    monkeypatch.setattr(mod, "_hermes_home", hermes_home)
    monkeypatch.setattr(mod, "_cfg_cache", None)
    monkeypatch.setattr(mod, "_cfg_mtime", None)
    monkeypatch.setattr(mod, "_cfg_path", None)
    yield mod
    # Reset module-level session state without re-importing. importlib.reload
    # would re-register the module's atexit hooks (ThreadPoolExecutor
    # shutdown, _shutdown_sessions); the duplicates race the stderr
    # buffer at interpreter shutdown and surface as Fatal Python error:
    # _enter_buffered_busy. Clearing the per-session dicts gives the
    # next test a clean slate.
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


class _InlineThread:
    """Run a turn synchronously so its automatic follow-up is observable."""

    def __init__(self, target=None, daemon=None, args=(), kwargs=None, **_extra):
        self._target = target
        self._args = args
        self._kwargs = kwargs or {}

    def start(self):
        if self._target is not None:
            self._target(*self._args, **self._kwargs)

    def is_alive(self):
        return False

    def join(self, timeout=None):
        return None


@pytest.fixture()
def turn_env(server, monkeypatch, tmp_path):
    """Neutralize side paths unrelated to post-turn goal continuation."""
    emitted = []
    monkeypatch.setattr(server.threading, "Thread", _InlineThread)
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: emitted.append((event, sid, payload)),
    )
    monkeypatch.setattr(server, "_wire_callbacks", lambda sid: None)
    monkeypatch.setattr(
        server, "_sync_agent_model_with_config", lambda sid, session: None
    )
    monkeypatch.setattr(server, "_session_cwd", lambda session: str(tmp_path))
    monkeypatch.setattr(server, "_register_session_cwd", lambda session: None)
    monkeypatch.setattr(server, "_tts_stream_begin", lambda: None)
    monkeypatch.setattr(
        server, "_sync_session_key_after_compress", lambda *a, **k: None
    )
    monkeypatch.setattr(server, "_get_usage", lambda agent: {})
    monkeypatch.setattr(server, "_load_cfg", lambda: {})
    return emitted


def _turn_session(agent, session_key):
    return {
        "agent": agent,
        "session_key": session_key,
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "running": True,
        "attached_images": [],
        "image_counter": 0,
        "cols": 80,
        "slash_worker": None,
        "show_reasoning": False,
        "tool_progress_mode": "all",
        "inflight_turn": None,
    }


def _compression_failure():
    message = "Context length exceeded: max compression attempts (3) reached."
    return {
        "final_response": message,
        "error": message,
        "failed": True,
        "partial": True,
        "compression_exhausted": True,
        "completed": False,
    }


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
    # #75362: resume dispatches the continuation prompt rather than merely
    # flipping state, so a paused goal actually restarts work.
    assert r["result"]["type"] == "send"
    assert "resumed" in r["result"]["notice"].lower()

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


def _exhaust_budget(session_key: str, goal_text: str = "finish the benchmark"):
    """Set a 1-turn goal and drive it to budget-exhaustion auto-pause."""
    from hermes_cli.goals import GoalManager

    mgr = GoalManager(session_key)
    mgr.set(goal_text, max_turns=1)
    with patch(
        "hermes_cli.goals.judge_goal",
        return_value=("continue", "needs more steps", False, None, False),
    ):
        decision = mgr.evaluate_after_turn("worked a bit")
    assert decision["status"] == "paused"
    assert decision["should_continue"] is False
    return mgr


def test_goal_resume_after_budget_exhaustion_dispatches_continuation(
    server, session
):
    """#75362: /goal resume must restart work, not just flip state.

    The pre-fix handler returned a display-only `exec` payload, so the
    resumed goal sat idle until the user sent another message. Resume
    must return a sendable dispatch carrying the canonical continuation
    prompt, with a concise `/goal resume` transcript projection.
    """
    from hermes_cli.goals import GoalManager

    sid, session_key, _ = session
    _exhaust_budget(session_key)
    assert GoalManager(session_key).state.status == "paused"

    r = _call(server, "command.dispatch", name="goal", arg="resume", session_id=sid)
    result = r["result"]
    assert result["type"] == "send"
    assert result["message"].startswith("[Continuing toward your standing goal]")
    assert result["display"] == "/goal resume"
    assert "Goal resumed" in result["notice"]

    state = GoalManager(session_key).state
    assert state.status == "active"
    assert state.turns_used == 0, "resume must reset the turn budget"


def test_goal_resume_without_goal_stays_exec(server, session):
    sid, _, _ = session
    r = _call(server, "command.dispatch", name="goal", arg="resume", session_id=sid)
    assert r["result"]["type"] == "exec"
    assert "No goal to resume" in r["result"]["output"]


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


# ── active-goal recovery after compression exhaustion ───────────────


def test_active_goal_retries_once_without_judging_failed_turn(
    server, turn_env, monkeypatch
):
    from hermes_cli.goals import GoalManager

    session_key = "goal-compression-retry"
    mgr = GoalManager(session_key)
    mgr.set("finish the current task")
    continuation = mgr.next_continuation_prompt()
    seen_prompts = []
    results = iter([_compression_failure(), {"final_response": "recovered work"}])

    def run_conversation(message, **_kwargs):
        seen_prompts.append(message)
        return next(results)

    judged = []

    def evaluate(self, response, **_kwargs):
        judged.append(response)
        return {"message": "", "should_continue": False}

    monkeypatch.setattr(GoalManager, "evaluate_after_turn", evaluate)
    agent = types.SimpleNamespace(
        session_id=session_key,
        run_conversation=run_conversation,
        clear_interrupt=lambda: None,
    )
    session = _turn_session(agent, session_key)

    server._run_prompt_submit("rid", "sid", session, "initial work")

    assert seen_prompts == ["initial work", continuation]
    assert judged == ["recovered work"]
    assert GoalManager(session_key).state.turns_used == 0
    assert server._GOAL_COMPRESSION_RECOVERY_ATTEMPTS not in session
    completes = [p for event, _sid, p in turn_env if event == "message.complete"]
    assert [p["status"] for p in completes] == ["error", "complete"]


def test_second_consecutive_exhaustion_pauses_goal_instead_of_looping(
    server, turn_env, monkeypatch
):
    from hermes_cli.goals import GoalManager

    session_key = "goal-compression-pause"
    GoalManager(session_key).set("finish the current task")
    seen_prompts = []

    def run_conversation(message, **_kwargs):
        seen_prompts.append(message)
        return _compression_failure()

    judged = []
    monkeypatch.setattr(
        GoalManager,
        "evaluate_after_turn",
        lambda self, response, **kwargs: judged.append(response),
    )
    agent = types.SimpleNamespace(
        session_id=session_key,
        run_conversation=run_conversation,
        clear_interrupt=lambda: None,
    )
    session = _turn_session(agent, session_key)

    server._run_prompt_submit("rid", "sid", session, "initial work")

    assert len(seen_prompts) == 2
    assert judged == []
    state = GoalManager(session_key).state
    assert state.status == "paused"
    assert state.turns_used == 0
    assert "compression exhausted twice" in state.paused_reason
    assert server._GOAL_COMPRESSION_RECOVERY_ATTEMPTS not in session
    notices = [
        p["text"]
        for event, _sid, p in turn_env
        if event == "status.update" and p.get("kind") == "goal"
    ]
    assert any("Retrying the active goal once" in text for text in notices)
    assert any("Goal paused" in text for text in notices)


def test_real_queued_prompt_preempts_goal_compression_retry(
    server, turn_env, monkeypatch
):
    from hermes_cli.goals import GoalManager

    session_key = "goal-compression-user-preempts"
    mgr = GoalManager(session_key)
    mgr.set("finish the current task")
    continuation = mgr.next_continuation_prompt()
    seen_prompts = []
    session_holder = {}

    def run_conversation(message, **_kwargs):
        seen_prompts.append(message)
        if len(seen_prompts) == 1:
            server._enqueue_prompt(session_holder["session"], "real user input", None)
            return _compression_failure()
        return {"final_response": "handled the user's update"}

    monkeypatch.setattr(
        GoalManager,
        "evaluate_after_turn",
        lambda self, response, **kwargs: {"message": "", "should_continue": False},
    )
    agent = types.SimpleNamespace(
        session_id=session_key,
        run_conversation=run_conversation,
        clear_interrupt=lambda: None,
    )
    session = _turn_session(agent, session_key)
    session_holder["session"] = session

    server._run_prompt_submit("rid", "sid", session, "initial work")

    assert seen_prompts == ["initial work", "real user input"]
    assert continuation not in seen_prompts
    assert server._GOAL_COMPRESSION_RECOVERY_ATTEMPTS not in session


def test_compression_deferred_is_not_treated_as_exhaustion(server):
    from hermes_cli.goals import GoalManager

    session_key = "goal-compression-deferred"
    GoalManager(session_key).set("finish the current task")
    session = {"session_key": session_key}

    prompt, notice = server._plan_goal_compression_recovery(
        session,
        {"compression_deferred": True, "failed": True},
        status="error",
        raw="Compression is already in progress.",
    )

    assert prompt is None
    assert notice is None
    assert server._GOAL_COMPRESSION_RECOVERY_ATTEMPTS not in session


def test_exhaustion_without_active_goal_keeps_error_only_behavior(server):
    session = {"session_key": "goal-compression-none"}

    prompt, notice = server._plan_goal_compression_recovery(
        session,
        _compression_failure(),
        status="error",
        raw="Context length exceeded.",
    )

    assert prompt is None
    assert notice is None
    assert server._GOAL_COMPRESSION_RECOVERY_ATTEMPTS not in session


def test_new_goal_does_not_inherit_previous_goal_recovery_attempt(server):
    from hermes_cli.goals import GoalManager

    session_key = "goal-compression-replaced"
    mgr = GoalManager(session_key)
    mgr.set("first goal")
    session = {"session_key": session_key}

    first_prompt, _ = server._plan_goal_compression_recovery(
        session,
        _compression_failure(),
        status="error",
        raw="Context length exceeded.",
    )
    mgr.set("replacement goal")
    replacement_prompt, replacement_notice = server._plan_goal_compression_recovery(
        session,
        _compression_failure(),
        status="error",
        raw="Context length exceeded.",
    )

    assert first_prompt is not None
    assert replacement_prompt is not None
    assert "replacement goal" in replacement_prompt
    assert "Retrying the active goal once" in replacement_notice
    assert GoalManager(session_key).state.status == "active"


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
