"""Gateway contracts for the ideation artifact surface."""

import pytest

from hermes_state import SessionDB
from tui_gateway import server


@pytest.fixture()
def artifact_session(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="stored-session", source="desktop", model="test")
    runtime_id = "runtime-session"
    monkeypatch.setattr(server, "_db", db)
    monkeypatch.setitem(
        server._sessions,
        runtime_id,
        {
            "profile_home": None,
            "session_key": "stored-session",
        },
    )
    try:
        yield runtime_id
    finally:
        server._sessions.pop(runtime_id, None)
        db.close()


def _result(method: str, **params):
    envelope = server._methods[method]("request-1", params)
    assert "error" not in envelope
    return envelope["result"]


def test_artifact_rpc_creates_and_lists_for_runtime_session(artifact_session):
    runtime_id = artifact_session

    created = _result(
        "artifact.create",
        session_id=runtime_id,
        artifact_id="map.main",
        kind="map",
        payload={"nodes": [], "edges": []},
        view_state={"positions": {}, "pinned": []},
        updated_by="ambient",
    )["artifact"]

    listed = _result("artifact.list", session_id=runtime_id)
    assert listed == {"artifacts": [created], "stored_session_id": "stored-session"}


def test_artifact_rpc_updates_semantics_and_view_independently(artifact_session):
    runtime_id = artifact_session
    _result(
        "artifact.create",
        session_id=runtime_id,
        artifact_id="map.main",
        kind="map",
        payload={"nodes": [], "edges": []},
        view_state={"positions": {}, "pinned": []},
        updated_by="ambient",
    )

    semantics = _result(
        "artifact.update_semantics",
        session_id=runtime_id,
        artifact_id="map.main",
        payload={"nodes": [{"id": "voice", "label": "Voice"}], "edges": []},
        expected_rev=1,
        updated_by="ambient",
    )["artifact"]
    view = _result(
        "artifact.update_view",
        session_id=runtime_id,
        artifact_id="map.main",
        view_state={"positions": {"voice": {"x": 100, "y": 80}}, "pinned": ["voice"]},
        expected_rev=1,
        updated_by="renderer",
    )["artifact"]

    assert semantics["semantic_rev"] == 2
    assert semantics["view_rev"] == 1
    assert view["semantic_rev"] == 2
    assert view["view_rev"] == 2
    assert view["payload"] == semantics["payload"]


def test_artifact_mutation_emits_session_scoped_event(artifact_session, monkeypatch):
    emitted = []
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: emitted.append((event, sid, payload)))

    created = _result(
        "artifact.create",
        session_id=artifact_session,
        artifact_id="map.main",
        kind="map",
        payload={"nodes": [], "edges": []},
        view_state={},
        updated_by="ambient",
    )["artifact"]

    assert emitted == [("artifact.updated", artifact_session, {"artifact": created})]
