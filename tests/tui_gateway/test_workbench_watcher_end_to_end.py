"""End-to-end direct watcher path from transcript RPC to persisted artifact."""

import copy
import threading
import time

from agent import oneshot
from hermes_cli.config_defaults import DEFAULT_CONFIG
from hermes_state import SessionDB
from tui_gateway import server
from workbench_watch_runtime import forget_session


def test_transcript_rpc_runs_one_direct_worker_and_persists(tmp_path, monkeypatch):
    """Exercise the production caller chain, not the watcher helper alone."""
    runtime_id = "runtime-direct-e2e"
    stored_id = "stored-direct-e2e"
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(stored_id, "desktop", model="test")
    session = {
        "session_key": stored_id,
        "profile_home": None,
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        # Freeze the same ownership the token would have returned.
        "_workbench_watcher": {
            "enabled": True,
            "mode": "active",
            "pipeline": "direct",
            "debounce_seconds": 0.01,
        },
    }
    server._sessions[runtime_id] = session
    monkeypatch.setattr(server, "_db", db)

    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["workbench"]["watcher"].update(session["_workbench_watcher"])
    monkeypatch.setattr(server, "_load_cfg", lambda: cfg)

    calls = []
    emitted = []
    completed = threading.Event()

    def model(**kwargs):
        calls.append(kwargs)
        # Busy must cover the real model call, not flash after it.
        assert any(event == "artifact.visualizing" and payload["active"] for event, _, payload in emitted)
        return (
            '{"draw":true,"reason":"new architecture","visual":'
            '{"kind":"map","layout":"linear","nodes":['
            '{"id":"input","label":"Input"},{"id":"agent","label":"Agent"}],'
            '"edges":[{"id":"e1","from":"input","to":"agent"}]}}'
        )

    monkeypatch.setattr(oneshot, "run_oneshot", model)

    def emit(event, sid, payload=None):
        emitted.append((event, sid, payload))
        if event == "artifact.updated":
            completed.set()

    monkeypatch.setattr(server, "_emit", emit)

    try:
        result = server._methods["voice.realtime.transcript"](
            "req",
            {
                "session_id": runtime_id,
                "item_id": "u1",
                "role": "user",
                "text": "Show input flowing into an agent",
            },
        )
        assert "error" not in result
        assert completed.wait(timeout=3), "direct watcher never persisted an artifact"

        artifact = db.get_session_artifact(stored_id, "map.main")
        assert artifact is not None
        assert artifact["payload"]["layout"] == "linear"
        assert [node["id"] for node in artifact["payload"]["nodes"]] == ["input", "agent"]
        assert len(calls) == 1
        assert [payload["active"] for event, _, payload in emitted if event == "artifact.visualizing"] == [
            True,
            False,
        ]
    finally:
        forget_session(stored_id)
        server._sessions.pop(runtime_id, None)
        db.close()
