"""`visualize` must announce that it STARTED, not only that it finished."""

from hermes_state import SessionDB
from tui_gateway import server
import workbench_visualizer


def _install(tmp_path, monkeypatch, visualize):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("stored-session", "desktop", model="test")
    server._sessions["runtime-session"] = {
        "session_key": "stored-session",
        "profile_home": None,
    }
    monkeypatch.setattr(server, "_db", db)
    emitted = []
    monkeypatch.setattr(workbench_visualizer, "visualize_session", visualize)
    monkeypatch.setattr(
        server, "_emit", lambda event, sid, payload=None: emitted.append((event, sid, payload))
    )
    return db, emitted


def test_emits_a_pending_signal_before_the_model_runs(tmp_path, monkeypatch):
    seen_before_model = []

    def visualize(owner_db, session_id, *, prompt):
        seen_before_model.extend(emitted)
        return {"artifact_id": "map.main", "kind": "map", "semantic_rev": 1}

    db, emitted = _install(tmp_path, monkeypatch, visualize)
    try:
        envelope = server._methods["workbench.visualize"](
            "r1", {"session_id": "runtime-session", "prompt": "draw"}
        )
    finally:
        server._sessions.pop("runtime-session", None)
        db.close()

    assert "error" not in envelope
    # The start edge landed BEFORE the model call, not after it.
    assert seen_before_model == [
        ("artifact.visualizing", "runtime-session", {"artifact_id": "map.main", "active": True})
    ]
    assert [event for event, _, _ in emitted] == [
        "artifact.visualizing",
        "artifact.updated",
        "artifact.visualizing",
    ]
    assert emitted[-1][2] == {"artifact_id": "map.main", "active": False}


def test_pending_signal_clears_when_the_drawing_fails(tmp_path, monkeypatch):
    def visualize(owner_db, session_id, *, prompt):
        raise RuntimeError("diagrammer exploded")

    db, emitted = _install(tmp_path, monkeypatch, visualize)
    try:
        envelope = server._methods["workbench.visualize"](
            "r1", {"session_id": "runtime-session", "prompt": "draw"}
        )
    finally:
        server._sessions.pop("runtime-session", None)
        db.close()

    assert envelope["error"]["code"] == 4621
    # A failure must not leave the user staring at a spinner forever.
    assert [event for event, _, _ in emitted] == [
        "artifact.visualizing",
        "artifact.visualizing",
    ]
    assert emitted[-1][2] == {"artifact_id": "map.main", "active": False}
