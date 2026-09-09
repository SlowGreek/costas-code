"""Behavioral seams retained when runtime code moved into upstream phases."""
from types import SimpleNamespace
import json


def test_structured_user_sidecar_survives_extracted_replay_helpers():
    from agent.turn_context import extract_api_content_sidecar, substitute_api_content
    content = [{"type": "text", "text": "correction"},
               {"type": "image_url", "image_url": {"url": "https://example.invalid/ref.png"}}]
    row = {"role": "user", "content": "clean", "api_content": content}
    assert extract_api_content_sidecar(row) == content
    wire = dict(row)
    assert substitute_api_content(wire) == content
    assert wire["content"] == content
    assert "api_content" not in wire
    assert row["content"] == "clean"


def test_extracted_child_builder_uses_each_tasks_credentials(monkeypatch):
    import tools.delegate_tool as delegate
    observed = []
    def build(**kwargs):
        observed.append(kwargs)
        return SimpleNamespace()
    monkeypatch.setattr(delegate, "_build_child_preserving_parent_tools", build)
    base = {"model": "parent", "provider": "copilot", "base_url": "https://parent.invalid",
            "api_key": "parent-test-key", "api_mode": "chat_completions"}
    other = {**base, "model": "child", "base_url": "https://child.invalid",
             "api_key": "child-test-key", "api_mode": "codex_responses"}
    children, error = delegate._build_children(
        [{"goal": "a"}, {"goal": "b"}], [None, None], base,
        top_role="leaf", max_iterations=3, parent_agent=SimpleNamespace(), routing_cfg={},
        live_deleg_id=None, live_writers=[], task_creds={1: other},
    )
    assert error is None and len(children) == 2
    assert [c["model"] for c in observed] == ["parent", "child"]
    assert observed[1]["override_base_url"] == other["base_url"]
    assert observed[1]["override_api_key"] == other["api_key"]
    assert observed[1]["override_api_mode"] == other["api_mode"]


def test_suppressed_terminal_event_is_durable_and_not_queued(tmp_path, monkeypatch):
    from tools import async_delegation as ad
    from tools.process_registry import process_registry
    import queue
    monkeypatch.setattr(ad, "_db_path", lambda: tmp_path / "delegations.db")
    monkeypatch.setattr(process_registry, "completion_queue", queue.Queue())
    seen = []
    record = {"delegation_id": "merge-contract-test", "goal": "bounded work",
              "session_key": "s", "dispatched_at": 1.0,
              "suppress_completion_delivery": True, "completion_callback": seen.append}
    ad._persist_dispatch(record)
    ad._push_completion_event(record, {"summary": "done"}, "completed")
    assert len(seen) == 1 and seen[0]["status"] == "completed"
    assert process_registry.completion_queue.empty()
    with ad._transaction() as connection:
        row = connection.execute(
            "SELECT delivery_state, result_json, task_json FROM async_delegations WHERE delegation_id=?",
            (record["delegation_id"],),
        ).fetchone()
    assert row[0] == "suppressed"
    assert json.loads(row[1])["summary"] == "done"
    assert json.loads(row[2])["suppress_completion_delivery"] is True


def test_shared_relay_context_retains_sync_and_async_branded_errors():
    import asyncio
    import threading
    from contextlib import nullcontext
    import pytest
    from agent.relay_runtime import RelayRuntime

    runtime = object.__new__(RelayRuntime)
    runtime._operation = nullcontext
    for closing, expected in ((True, "Catalyst Relay session is closing"),
                              (False, "Catalyst Relay session context is unavailable")):
        session = SimpleNamespace(lock=threading.RLock(), closing=closing, context=None, handle=None)
        with pytest.raises(RuntimeError, match=expected):
            runtime.run_in_session(session, lambda: None)
        with pytest.raises(RuntimeError, match=expected):
            asyncio.run(runtime.run_in_session_async(session, lambda: None))
