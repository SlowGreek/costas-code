from hermes_state import SessionDB
from tui_gateway import server
import workbench_visualizer


def test_workbench_visualize_rpc_delegates_and_emits_artifact(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    runtime_id = "runtime-session"
    db.create_session("stored-session", "desktop", model="test")
    session = {"session_key": "stored-session", "profile_home": None}
    server._sessions[runtime_id] = session
    monkeypatch.setattr(server, "_db", db)
    captured = {}
    emitted = []

    def visualize(owner_db, session_id, *, prompt):
        captured.update(db=owner_db, session_id=session_id, prompt=prompt)
        return {
            "session_id": session_id,
            "artifact_id": "map.main",
            "kind": "map",
            "semantic_rev": 2,
            "view_rev": 1,
            "payload": {"nodes": [], "edges": []},
            "view_state": {},
        }

    monkeypatch.setattr(workbench_visualizer, "visualize_session", visualize)
    monkeypatch.setattr(server, "_emit", lambda event, sid, payload=None: emitted.append((event, sid, payload)))
    try:
        envelope = server._methods["workbench.visualize"](
            "request-1",
            {
                "session_id": runtime_id,
                "prompt": "Show the shared state as the center.",
            },
        )
    finally:
        server._sessions.pop(runtime_id, None)
        db.close()

    assert "error" not in envelope
    artifact = envelope["result"]["artifact"]
    assert captured == {
        "db": db,
        "session_id": "stored-session",
        "prompt": "Show the shared state as the center.",
    }
    assert emitted == [("artifact.updated", runtime_id, {"artifact": artifact})]
    assert "workbench.visualize" in server._LONG_HANDLERS
