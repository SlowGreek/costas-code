import json

import pytest

from tui_gateway import server
from tools import async_delegation, delegate_tool


class _Agent:
    pass


@pytest.fixture
def research_session(tmp_path):
    runtime_id = "runtime-research"
    session = {
        "session_key": "stored-research",
        "profile_home": str(tmp_path),
        "agent": _Agent(),
    }
    server._sessions[runtime_id] = session
    try:
        yield runtime_id, session, tmp_path
    finally:
        server._sessions.pop(runtime_id, None)


def _dispatch(runtime_id, monkeypatch, *, result=None, mission_id="mission_alpha"):
    captured = {}

    def fake_delegate_task(**kwargs):
        captured.update(kwargs)
        return json.dumps(
            result
            or {
                "status": "dispatched",
                "delegation_id": "deleg_research123",
            }
        )

    monkeypatch.setattr(delegate_tool, "delegate_task", fake_delegate_task)
    envelope = server._methods["voice.realtime.delegate_research"](
        "dispatch",
        {
            "session_id": runtime_id,
            "query": "Trace Claude Code architecture",
            "mission_id": mission_id,
        },
    )
    return envelope, captured


def test_delegate_research_is_silent_bounded_and_server_paths_the_artifact(
    research_session, monkeypatch
):
    runtime_id, _, profile_home = research_session
    envelope, captured = _dispatch(runtime_id, monkeypatch)

    assert "error" not in envelope
    result = envelope["result"]
    assert result["status"] == "dispatched"
    assert result["delegation_id"] == "deleg_research123"
    assert result["mission_id"] == "mission_alpha"
    assert result["artifact_id"].startswith("research_")
    assert captured["background"] is True
    assert captured["role"] == "leaf"
    assert captured["suppress_completion_delivery"] is True
    assert captured["reject_if_async_capacity"] is True
    assert captured["parent_agent"].__class__ is _Agent

    metadata_files = list(
        (profile_home / "research" / "stored-research" / result["artifact_id"]).glob("request.json")
    )
    assert len(metadata_files) == 1
    metadata = json.loads(metadata_files[0].read_text())
    assert metadata["delegation_id"] == "deleg_research123"
    assert metadata["mission_id"] == "mission_alpha"
    assert metadata["query"] == "Trace Claude Code architecture"
    research_path = metadata_files[0].with_name("research.md")
    assert str(research_path) in captured["goal"]
    assert "cited" in captured["goal"].lower()
    assert "read_file" in captured["goal"]


def test_research_status_requires_terminal_delegation_and_nonempty_artifact(
    research_session, monkeypatch
):
    runtime_id, _, _ = research_session
    dispatched, _ = _dispatch(runtime_id, monkeypatch)
    artifact_id = dispatched["result"]["artifact_id"]

    from tui_gateway.realtime_research import research_artifact_paths

    paths = research_artifact_paths(server._sessions[runtime_id], artifact_id)
    paths.research.write_text("partial draft", encoding="utf-8")

    monkeypatch.setattr(
        async_delegation,
        "get_durable_delegation",
        lambda _: {
            "delegation_id": "deleg_research123",
            "origin_session": "stored-research",
            "state": "running",
            "result": None,
        },
    )
    running = server._methods["voice.realtime.research_status"](
        "status-running", {"session_id": runtime_id, "artifact_id": artifact_id}
    )
    assert running["result"]["status"] == "running"
    blocked_read = server._methods["voice.realtime.research_read"](
        "read-running", {"session_id": runtime_id, "artifact_id": artifact_id}
    )
    assert blocked_read["error"]["code"] == 4618

    paths.research.unlink()
    monkeypatch.setattr(
        async_delegation,
        "get_durable_delegation",
        lambda _: {
            "delegation_id": "deleg_research123",
            "origin_session": "stored-research",
            "state": "completed",
            "result": {"status": "completed"},
        },
    )
    missing = server._methods["voice.realtime.research_status"](
        "status-missing", {"session_id": runtime_id, "artifact_id": artifact_id}
    )
    assert missing["result"]["status"] == "failed"
    assert "artifact" in missing["result"]["error"].lower()

    paths.research.write_text(
        "# Architecture\n\nEvidence with citation https://example.com\n", encoding="utf-8"
    )
    ready = server._methods["voice.realtime.research_status"](
        "status-ready", {"session_id": runtime_id, "artifact_id": artifact_id}
    )
    assert ready["result"]["status"] == "ready"
    assert ready["result"]["line_count"] == 3
    recovered = server._methods["voice.realtime.research_status"](
        "status-latest", {"session_id": runtime_id}
    )
    assert recovered["result"]["artifact_id"] == artifact_id
    assert recovered["result"]["mission_id"] == "mission_alpha"
    assert recovered["result"]["status"] == "ready"


def test_delegate_research_requires_mission_identity(research_session, monkeypatch):
    runtime_id, _, _ = research_session
    envelope, captured = _dispatch(runtime_id, monkeypatch, mission_id="")

    assert envelope["error"]["code"] == 4618
    assert "mission_id" in envelope["error"]["message"]
    assert captured == {}


def test_terminal_research_emits_ready_on_originating_runtime_session(
    research_session, monkeypatch
):
    runtime_id, session, _ = research_session
    emitted = []
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: emitted.append((event, sid, payload)),
    )
    dispatched, captured = _dispatch(runtime_id, monkeypatch)
    result = dispatched["result"]

    from tui_gateway.realtime_research import research_artifact_paths

    research_artifact_paths(session, result["artifact_id"]).research.write_text(
        "Evidence https://example.com\n", encoding="utf-8"
    )
    monkeypatch.setattr(
        async_delegation,
        "get_durable_delegation",
        lambda _: {
            "delegation_id": result["delegation_id"],
            "origin_session": "stored-research",
            "state": "completed",
            "result": {"status": "completed"},
        },
    )

    captured["completion_callback"](
        {"delegation_id": result["delegation_id"], "status": "completed"}
    )

    assert emitted == [
        (
            "voice.realtime.research.ready",
            runtime_id,
            {
                "mission_id": "mission_alpha",
                "artifact_id": result["artifact_id"],
                "delegation_id": result["delegation_id"],
            },
        )
    ]


def test_terminal_research_emits_failed_without_worker_error_details(
    research_session, monkeypatch
):
    runtime_id, _, _ = research_session
    emitted = []
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: emitted.append((event, sid, payload)),
    )
    dispatched, captured = _dispatch(runtime_id, monkeypatch)
    result = dispatched["result"]
    monkeypatch.setattr(
        async_delegation,
        "get_durable_delegation",
        lambda _: {
            "delegation_id": result["delegation_id"],
            "origin_session": "stored-research",
            "state": "error",
            "result": {"error": "secret token at /Users/private/report"},
        },
    )

    captured["completion_callback"](
        {"delegation_id": result["delegation_id"], "status": "error"}
    )

    event, sid, payload = emitted[-1]
    assert event == "voice.realtime.research.failed"
    assert sid == runtime_id
    assert payload["mission_id"] == "mission_alpha"
    assert payload["artifact_id"] == result["artifact_id"]
    assert payload["delegation_id"] == result["delegation_id"]
    assert payload["error"] == "research delegation ended with error"
    assert "secret" not in payload["error"]


def test_research_read_and_search_are_bounded_and_session_scoped(research_session, monkeypatch):
    runtime_id, _, _ = research_session
    dispatched, _ = _dispatch(runtime_id, monkeypatch)
    artifact_id = dispatched["result"]["artifact_id"]

    monkeypatch.setattr(
        async_delegation,
        "get_durable_delegation",
        lambda _: {
            "delegation_id": "deleg_research123",
            "origin_session": "stored-research",
            "state": "completed",
            "result": {"status": "completed"},
        },
    )
    from tui_gateway.realtime_research import research_artifact_paths

    paths = research_artifact_paths(server._sessions[runtime_id], artifact_id)
    paths.research.write_text(
        "# Claude Code\n\nPlanner owns the loop.\nExecutor runs tools.\nPlanner verifies results.\n",
        encoding="utf-8",
    )

    read = server._methods["voice.realtime.research_read"](
        "read",
        {
            "session_id": runtime_id,
            "artifact_id": artifact_id,
            "start_line": 2,
            "line_count": 2,
        },
    )["result"]
    assert read["text"] == "\nPlanner owns the loop."
    assert read["start_line"] == 2
    assert read["next_line"] == 4

    search = server._methods["voice.realtime.research_search"](
        "search",
        {"session_id": runtime_id, "artifact_id": artifact_id, "query": "planner"},
    )["result"]
    assert [match["line"] for match in search["matches"]] == [3, 5]
    assert all("text" in match for match in search["matches"])

    other_runtime = "runtime-other"
    server._sessions[other_runtime] = {
        "session_key": "stored-other",
        "profile_home": server._sessions[runtime_id]["profile_home"],
        "agent": _Agent(),
    }
    try:
        denied = server._methods["voice.realtime.research_read"](
            "denied", {"session_id": other_runtime, "artifact_id": artifact_id}
        )
    finally:
        server._sessions.pop(other_runtime, None)
    assert denied["error"]["code"] == 4618


def test_delegate_research_fails_fast_when_async_capacity_is_full(
    research_session, monkeypatch
):
    runtime_id, _, _ = research_session
    envelope, _ = _dispatch(
        runtime_id,
        monkeypatch,
        result={"status": "rejected", "error": "Async delegation capacity reached"},
    )
    assert envelope["error"]["code"] == 4618
    assert "capacity" in envelope["error"]["message"].lower()
    assert "voice.realtime.delegate_research" in server._LONG_HANDLERS
