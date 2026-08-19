"""Tests for gateway /goal verdict-message delivery.

The judge verdict message ("✓ Goal achieved", "⏸ budget exhausted", etc.)
must reach the user after each turn. Before this fix the code checked
``hasattr(adapter, "send_message")`` — but adapters expose ``send()``,
never ``send_message``, so the check always evaluated False and users
never saw verdicts. This test locks in the fix.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.session import SessionEntry, SessionSource, build_session_key


@pytest.fixture()
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))

    from hermes_cli import goals

    goals._DB_CACHE.clear()
    # Pre-warm the SessionDB cache from this SYNC context. The tests call
    # GoalManager.set() on the event-loop thread, where _get_session_db()
    # refuses to construct SessionDB inline (loop-liveness guard) and only
    # waits _DB_BOOTSTRAP_LOOP_WAIT_S for a background bootstrap. On a loaded
    # CI runner the init overruns that window, the goal write is silently
    # dropped by design, and the continuation path no-ops — the recurring
    # sends == [] flake. Warming here uses the direct construction path, so
    # the loop-thread set() always finds a cached DB.
    goals._get_session_db()
    yield home
    goals._DB_CACHE.clear()


def _make_source() -> SessionSource:
    return SessionSource(
        platform=Platform.TELEGRAM,
        user_id="u1",
        chat_id="c1",
        user_name="tester",
        chat_type="dm",
    )


class _RecordingAdapter:
    """Minimal adapter that records send() invocations."""

    def __init__(self) -> None:
        self._pending_messages: dict = {}
        self.sends: list[dict] = []

    async def send(self, chat_id: str, content: str, reply_to=None, metadata=None):
        self.sends.append({"chat_id": chat_id, "content": content, "metadata": metadata})

        class _R:
            success = True
            message_id = "mock-msg"

        return _R()


def _make_runner_with_adapter(session_id: str = None):
    from gateway.run import GatewayRunner
    import uuid

    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(
        platforms={Platform.TELEGRAM: PlatformConfig(enabled=True, token="***")},
    )
    runner.adapters = {}
    runner._running_agents = {}
    runner._running_agents_ts = {}
    runner._queued_events = {}

    src = _make_source()
    # Default to a unique session_id so xdist parallel runs on the same worker
    # don't see each other's GoalManager state (DEFAULT_DB_PATH gets frozen at
    # module-import time, defeating per-test HERMES_HOME monkeypatches).
    session_entry = SessionEntry(
        session_key=build_session_key(src),
        session_id=session_id or f"goal-sess-{uuid.uuid4().hex[:8]}",
        created_at=datetime.now(),
        updated_at=datetime.now(),
        platform=Platform.TELEGRAM,
        chat_type="dm",
    )

    runner.session_store = MagicMock()
    runner.session_store.get_or_create_session.return_value = session_entry
    runner.session_store._generate_session_key.return_value = build_session_key(src)

    adapter = _RecordingAdapter()
    runner.adapters[Platform.TELEGRAM] = adapter
    return runner, adapter, session_entry, src


async def _drain_until(condition, timeout=5.0):
    """Yield to the event loop until ``condition()`` is truthy (bounded).

    The goal-continuation path finishes its sends/enqueues on spawned tasks;
    a fixed 0.05s sleep raced them on loaded CI runners (#88975). Returns as
    soon as the condition holds — the asserts after the call stay exact.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while not condition() and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_goal_verdict_continue_enqueues_continuation(hermes_home):
    """When the judge says continue, both the 'continuing' status and the
    continuation-prompt event must be delivered. The continuation prompt is
    routed through the adapter's pending-messages FIFO so the goal loop
    proceeds on the next turn."""
    runner, adapter, session_entry, src = _make_runner_with_adapter()

    from hermes_cli.goals import GoalManager

    mgr = GoalManager(session_entry.session_id)
    mgr.set("polish the docs")

    with patch("hermes_cli.goals.judge_goal", return_value=("continue", "still needs work", False, None, False)):
        await runner._post_turn_goal_continuation(
            session_entry=session_entry,
            source=src,
            final_response="here's a partial edit",
        )
        await _drain_until(lambda: adapter.sends and adapter._pending_messages)

    # Status line sent back
    assert len(adapter.sends) == 1
    assert "Continuing toward goal" in adapter.sends[0]["content"]
    # Continuation prompt enqueued for next turn
    assert adapter._pending_messages, "continuation prompt must be enqueued in pending_messages"


@pytest.mark.asyncio
async def test_goal_verdict_budget_exhausted_sends_pause(hermes_home):
    """When the budget is exhausted, a '⏸ Goal paused' message must be sent
    and no further continuation enqueued."""
    runner, adapter, session_entry, src = _make_runner_with_adapter()

    from hermes_cli.goals import GoalManager, save_goal

    mgr = GoalManager(session_entry.session_id, default_max_turns=2)
    state = mgr.set("tiny goal", max_turns=2)
    state.turns_used = 2
    save_goal(session_entry.session_id, state)

    with patch("hermes_cli.goals.judge_goal", return_value=("continue", "keep going", False, None, False)):
        await runner._post_turn_goal_continuation(
            session_entry=session_entry,
            source=src,
            final_response="still partial",
        )
        await _drain_until(lambda: adapter.sends)

    assert len(adapter.sends) == 1
    content = adapter.sends[0]["content"]
    assert "paused" in content.lower()
    assert "turns used" in content.lower()
    # No continuation enqueued when budget is exhausted
    assert not adapter._pending_messages


@pytest.mark.asyncio
async def test_goal_verdict_skipped_when_no_active_goal(hermes_home):
    """No goal set → the hook is a no-op. Nothing is sent, nothing enqueued."""
    runner, adapter, session_entry, src = _make_runner_with_adapter()

    await runner._post_turn_goal_continuation(
        session_entry=session_entry,
        source=src,
        final_response="anything",
    )
    await asyncio.sleep(0.05)

    assert adapter.sends == []
    assert adapter._pending_messages == {}


@pytest.mark.asyncio
async def test_goal_verdict_survives_adapter_without_send(hermes_home):
    """Bad adapter (no ``send`` attribute) must not crash the judge hook."""
    runner, _adapter, session_entry, src = _make_runner_with_adapter()

    from hermes_cli.goals import GoalManager

    GoalManager(session_entry.session_id).set("survive missing send")

    class _NoSendAdapter:
        def __init__(self):
            self._pending_messages: dict = {}

    runner.adapters[Platform.TELEGRAM] = _NoSendAdapter()

    with patch("hermes_cli.goals.judge_goal", return_value=("done", "ok", False, None, False)):
        # must not raise
        await runner._post_turn_goal_continuation(
            session_entry=session_entry,
            source=src,
            final_response="whatever",
        )
        await asyncio.sleep(0.05)


# ── R5: interrupted / partial turns must not be judged or continued ────


class _AsyncSessionStore:
    def __init__(self, session_entry, store):
        self._entry = session_entry
        self._store = store

    async def get_or_create_session(self, source):
        return self._entry


def test_post_turn_goal_should_judge_skips_interrupted():
    from gateway.run import GatewayRunner

    # Interrupted turn with partial text → must NOT judge.
    should, text = GatewayRunner._post_turn_goal_should_judge(
        {"final_response": "partial work so far", "interrupted": True}
    )
    assert should is False
    assert text == "partial work so far"


def test_post_turn_goal_should_judge_skips_failed():
    from gateway.run import GatewayRunner

    should, _ = GatewayRunner._post_turn_goal_should_judge(
        {"final_response": "boom", "failed": True}
    )
    assert should is False


def test_post_turn_goal_should_judge_skips_empty():
    from gateway.run import GatewayRunner

    should, _ = GatewayRunner._post_turn_goal_should_judge({"final_response": "   "})
    assert should is False


def test_post_turn_goal_should_judge_runs_on_clean_turn():
    from gateway.run import GatewayRunner

    should, text = GatewayRunner._post_turn_goal_should_judge(
        {"final_response": "here is the finished result"}
    )
    assert should is True
    assert "finished" in text


@pytest.mark.asyncio
async def test_stop_pauses_active_goal(hermes_home):
    """A user /stop must PAUSE the goal loop (recoverable), not keep going."""
    runner, adapter, session_entry, src = _make_runner_with_adapter()
    runner._async_session_store = _AsyncSessionStore(session_entry, runner.session_store)

    from hermes_cli.goals import GoalManager

    GoalManager(session_entry.session_id).set("keep grinding")

    await runner._pause_goal_for_interrupt(src, reason="user-stopped (/stop)")

    mgr = GoalManager(session_entry.session_id)
    assert mgr.state.status == "paused"
    assert "stop" in (mgr.state.paused_reason or "").lower()


@pytest.mark.asyncio
async def test_pause_for_interrupt_noop_without_goal(hermes_home):
    """No active goal → interrupt-pause is a harmless no-op."""
    runner, adapter, session_entry, src = _make_runner_with_adapter()
    runner._async_session_store = _AsyncSessionStore(session_entry, runner.session_store)

    # Must not raise even though no goal exists.
    await runner._pause_goal_for_interrupt(src, reason="user-stopped")

    from hermes_cli.goals import GoalManager

    assert GoalManager(session_entry.session_id).state is None


@pytest.mark.asyncio
async def test_post_turn_continuation_scopes_background_to_session(hermes_home, monkeypatch):
    """The gateway must scope background-process gathering to this session's
    key so the judge never sees another session's jobs (R4)."""
    runner, adapter, session_entry, src = _make_runner_with_adapter()

    from hermes_cli.goals import GoalManager

    GoalManager(session_entry.session_id).set("ship it")

    captured = {}

    def _fake_gather(task_id=None, session_key=None):
        captured["session_key"] = session_key
        return []

    monkeypatch.setattr("hermes_cli.goals.gather_background_processes", _fake_gather)

    with patch("hermes_cli.goals.judge_goal", return_value=("continue", "more", False, None, False)):
        await runner._post_turn_goal_continuation(
            session_entry=session_entry,
            source=src,
            final_response="partial progress",
        )
        await asyncio.sleep(0.05)

    from gateway.session import build_session_key

    assert captured.get("session_key") == build_session_key(src)


@pytest.mark.asyncio
async def test_foreground_tool_evidence_reaches_verifier(hermes_home):
    """Fix 1: the gateway must forward THIS turn's real tool/test results into
    the second-stage completion verifier — otherwise a verified contract goal
    loops because its passing tests are invisible."""
    runner, adapter, session_entry, src = _make_runner_with_adapter()

    from hermes_cli.goals import GoalManager, GoalContract, extract_recent_tool_evidence

    GoalManager(session_entry.session_id).set(
        "ship it", contract=GoalContract(verification="pytest passes")
    )

    # A real turn transcript (what run_conversation returns in _agent_result):
    # a tool result proving the tests passed, plus the agent's prose claim.
    messages = [
        {"role": "user", "content": "run the tests"},
        {"role": "tool", "name": "terminal", "content": "42 passed, 0 failed in 3.2s"},
        {"role": "assistant", "content": "All tests pass — done."},
    ]
    evidence = extract_recent_tool_evidence(messages)
    assert any("42 passed" in e for e in evidence)

    captured = {}

    def _verifier(**kwargs):
        # judge is patched out, so the only call_llm here is the verifier.
        captured["user"] = " ".join(
            m.get("content", "") for m in kwargs.get("messages", []) if m.get("role") == "user"
        )

        class _M:
            content = '{"confirmed": true, "reason": "42 passed shown"}'

        class _C:
            message = _M()

        class _R:
            choices = [_C()]

        return _R()

    with patch("hermes_cli.goals.judge_goal", return_value=("done", "looks done", False, None, False)), patch(
        "agent.auxiliary_client.call_llm", side_effect=_verifier
    ):
        await runner._post_turn_goal_continuation(
            session_entry=session_entry,
            source=src,
            final_response="All tests pass — done.",
            recent_evidence=evidence,
        )
        await asyncio.sleep(0.05)

    assert "42 passed" in (captured.get("user") or ""), "tool evidence must reach the verifier prompt"
    assert GoalManager(session_entry.session_id).state.status == "done"
