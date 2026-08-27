"""`workbench.edit` / `workbench.focus`: instant writes with no diagrammer call."""

import pytest

import workbench_visualizer
from hermes_state import SessionDB
from tui_gateway import server

PAYLOAD = {
    "nodes": [{"id": "a", "label": "Alpha"}, {"id": "b", "label": "Beta"}],
    "edges": [{"id": "e1", "from": "a", "to": "b"}],
}


@pytest.fixture
def wired(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    runtime_id = "runtime-session"
    db.create_session("stored-session", "desktop", model="test")
    db.create_session_artifact(
        "stored-session",
        "map.main",
        kind="map",
        payload=PAYLOAD,
        view_state={"positions": {}, "pinned": []},
        updated_by="test",
    )
    server._sessions[runtime_id] = {"session_key": "stored-session", "profile_home": None}
    monkeypatch.setattr(server, "_db", db)
    emitted = []
    monkeypatch.setattr(
        server, "_emit", lambda event, sid, payload=None: emitted.append((event, sid, payload))
    )

    def explode(*args, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("surgical edits must not call the diagrammer")

    monkeypatch.setattr(workbench_visualizer, "visualize_session", explode)
    try:
        yield db, runtime_id, emitted
    finally:
        server._sessions.pop(runtime_id, None)
        db.close()


def test_rename_bumps_semantic_rev_and_emits(wired):
    db, runtime_id, emitted = wired
    envelope = server._methods["workbench.edit"](
        "r1",
        {
            "session_id": runtime_id,
            "edit": {"op": "rename", "node_id": "a", "label": "Planner"},
        },
    )
    assert "error" not in envelope
    artifact = envelope["result"]["artifact"]
    assert artifact["semantic_rev"] == 2
    assert artifact["payload"]["nodes"][0]["label"] == "Planner"
    # Node ids stay stable.
    assert [n["id"] for n in artifact["payload"]["nodes"]] == ["a", "b"]
    assert ("artifact.updated", runtime_id, {"artifact": artifact}) in emitted
    # Persisted, not just returned.
    assert db.get_session_artifact("stored-session", "map.main")["payload"]["nodes"][0][
        "label"
    ] == "Planner"


def test_add_node_bumps_semantic_rev_and_emits(wired):
    _, runtime_id, emitted = wired
    envelope = server._methods["workbench.edit"](
        "r-add",
        {
            "session_id": runtime_id,
            "edit": {"op": "add_node", "id": "planner", "label": "Planner", "kind": "agent"},
        },
    )
    assert "error" not in envelope
    artifact = envelope["result"]["artifact"]
    assert artifact["semantic_rev"] == 2
    assert artifact["payload"]["nodes"][-1] == {
        "id": "planner",
        "label": "Planner",
        "kind": "agent",
    }
    assert ("artifact.updated", runtime_id, {"artifact": artifact}) in emitted


def test_first_add_node_bootstraps_an_empty_map_for_immediate_focus(tmp_path, monkeypatch):
    """The first present_step must not need a prior whole-canvas visualization."""
    db = SessionDB(db_path=tmp_path / "state.db")
    runtime_id = "runtime-empty-map"
    db.create_session("stored-empty-map", "desktop", model="test")
    server._sessions[runtime_id] = {"session_key": "stored-empty-map", "profile_home": None}
    monkeypatch.setattr(server, "_db", db)
    emitted = []
    monkeypatch.setattr(
        server, "_emit", lambda event, sid, payload=None: emitted.append((event, sid, payload))
    )

    try:
        added = server._methods["workbench.edit"](
            "r-first-add",
            {
                "session_id": runtime_id,
                "edit": {
                    "op": "add_node",
                    "id": "audio-input",
                    "label": "Audio Input",
                    "kind": "surface",
                },
            },
        )

        assert "error" not in added
        artifact = added["result"]["artifact"]
        assert artifact["semantic_rev"] == 1
        assert artifact["payload"] == {
            "nodes": [{"id": "audio-input", "label": "Audio Input", "kind": "surface"}],
            "edges": [],
        }

        focused = server._methods["workbench.focus"](
            "r-first-focus",
            {"session_id": runtime_id, "node_id": "audio-input"},
        )
        assert "error" not in focused
        assert focused["result"]["artifact"]["view_state"]["focus"] == "audio-input"
        assert [event for event, _, _ in emitted] == ["artifact.updated", "artifact.updated"]
    finally:
        server._sessions.pop(runtime_id, None)
        db.close()


def test_remove_drops_dangling_edges(wired):
    _, runtime_id, _ = wired
    envelope = server._methods["workbench.edit"](
        "r2", {"session_id": runtime_id, "edit": {"op": "remove", "node_id": "b"}}
    )
    payload = envelope["result"]["artifact"]["payload"]
    assert [n["id"] for n in payload["nodes"]] == ["a"]
    assert payload["edges"] == []


def test_bad_edit_is_rejected_without_touching_the_artifact(wired):
    db, runtime_id, _ = wired
    envelope = server._methods["workbench.edit"](
        "r3", {"session_id": runtime_id, "edit": {"op": "remove", "node_id": "ghost"}}
    )
    assert envelope["error"]["code"] == 4622
    stored = db.get_session_artifact("stored-session", "map.main")
    assert stored["semantic_rev"] == 1
    assert stored["payload"] == PAYLOAD


def test_focus_is_view_only(wired):
    db, runtime_id, _ = wired
    envelope = server._methods["workbench.focus"](
        "r4", {"session_id": runtime_id, "node_id": "b"}
    )
    artifact = envelope["result"]["artifact"]
    assert artifact["view_state"]["focus"] == "b"
    # Focus never touches the ideas.
    assert artifact["semantic_rev"] == 1
    assert artifact["view_rev"] == 2
    assert artifact["payload"] == PAYLOAD


def test_focus_rejects_an_unknown_node(wired):
    _, runtime_id, _ = wired
    envelope = server._methods["workbench.focus"](
        "r5", {"session_id": runtime_id, "node_id": "ghost"}
    )
    assert envelope["error"]["code"] == 4622


def test_edit_preserves_user_pins_in_view_state(wired):
    """A semantic edit must not clobber the user's deliberate placements."""
    db, runtime_id, _ = wired
    db.update_artifact_view_state(
        "stored-session",
        "map.main",
        view_state={"positions": {"a": {"x": 1, "y": 1}}, "user_pins": {"a": {"x": 400, "y": 200}}},
        expected_rev=1,
        updated_by="user-drag",
    )
    envelope = server._methods["workbench.edit"](
        "r6",
        {"session_id": runtime_id, "edit": {"op": "rename", "node_id": "a", "label": "Planner"}},
    )
    assert envelope["result"]["artifact"]["view_state"]["user_pins"] == {"a": {"x": 400, "y": 200}}
