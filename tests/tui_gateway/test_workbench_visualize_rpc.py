import json
import threading
import time

from agent import oneshot
from hermes_state import SessionDB
from hermes_state_artifacts import ArtifactRevisionConflict
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
    # `artifact.visualizing` now brackets the drawing (see
    # test_workbench_visualize_pending.py); the completion contract is unchanged.
    assert [entry for entry in emitted if entry[0] == "artifact.updated"] == [
        ("artifact.updated", runtime_id, {"artifact": artifact})
    ]
    assert "workbench.visualize" in server._LONG_HANDLERS


def test_visualize_regenerates_once_after_concurrent_instant_edit(tmp_path, monkeypatch):
    """The accepted instant edit and requested structural redraw must both survive."""
    db = SessionDB(db_path=tmp_path / "state.db")
    runtime_id = "runtime-conflict"
    db.create_session("stored-conflict", "desktop", model="test")
    db.create_session_artifact(
        "stored-conflict",
        "map.main",
        kind="map",
        payload={
            "nodes": [
                {"id": "a", "label": "Alpha"},
                {"id": "b", "label": "Beta"},
            ],
            "edges": [],
        },
        view_state={"positions": {}, "pinned": []},
        updated_by="test",
    )
    server._sessions[runtime_id] = {"session_key": "stored-conflict", "profile_home": None}
    monkeypatch.setattr(server, "_db", db)
    calls = []
    emitted = []

    def model(**kwargs):
        request = json.loads(kwargs["user_input"])
        calls.append(request)
        if len(calls) == 1:
            current = db.get_session_artifact("stored-conflict", "map.main")
            assert current is not None
            edited = {
                **current["payload"],
                "nodes": [
                    {**node, "label": "Edited"} if node["id"] == "a" else node
                    for node in current["payload"]["nodes"]
                ],
            }
            db.update_artifact_semantics(
                "stored-conflict",
                "map.main",
                payload=edited,
                expected_rev=current["semantic_rev"],
                updated_by="voice-edit",
            )
        return json.dumps(
            {"ops": [{"op": "add_node", "id": "memory", "label": "Memory"}]}
        )

    monkeypatch.setattr(oneshot, "run_oneshot", model)
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: emitted.append((event, sid, payload)),
    )
    try:
        envelope = server._methods["workbench.visualize"](
            "request-conflict",
            {"session_id": runtime_id, "prompt": "Add the memory layer."},
        )
    finally:
        server._sessions.pop(runtime_id, None)
        db.close()

    assert "error" not in envelope
    assert len(calls) == 2
    assert calls[0]["direction"] == calls[1]["direction"] == "Add the memory layer."
    assert calls[1]["current_graph"]["nodes"][0]["label"] == "Edited"
    artifact = envelope["result"]["artifact"]
    assert [(node["id"], node["label"]) for node in artifact["payload"]["nodes"]] == [
        ("a", "Edited"),
        ("b", "Beta"),
        ("memory", "Memory"),
    ]
    assert artifact["updated_by"] == "ambient-diff"
    assert [event for event, _, _ in emitted].count("artifact.updated") == 1


def test_visualize_revision_retry_is_bounded_and_clears_busy(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    runtime_id = "runtime-conflict-loop"
    db.create_session("stored-conflict-loop", "desktop", model="test")
    server._sessions[runtime_id] = {
        "session_key": "stored-conflict-loop",
        "profile_home": None,
    }
    monkeypatch.setattr(server, "_db", db)
    calls = []
    emitted = []

    def conflict(*_args, **_kwargs):
        calls.append(True)
        raise ArtifactRevisionConflict("still stale")

    monkeypatch.setattr(workbench_visualizer, "visualize_session", conflict)
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: emitted.append((event, sid, payload)),
    )
    try:
        envelope = server._methods["workbench.visualize"](
            "request-conflict-loop",
            {"session_id": runtime_id, "prompt": "Organize it."},
        )
    finally:
        server._sessions.pop(runtime_id, None)
        db.close()

    assert envelope["error"]["code"] == 4621
    assert calls == [True, True]
    assert [payload["active"] for event, _, payload in emitted if event == "artifact.visualizing"] == [
        True,
        False,
    ]


def test_overlapping_visualize_requests_serialize_under_one_busy_window(tmp_path, monkeypatch):
    db = SessionDB(db_path=tmp_path / "state.db")
    runtime_id = "runtime-overlap"
    db.create_session("stored-overlap", "desktop", model="test")
    session = {"session_key": "stored-overlap", "profile_home": None}
    server._sessions[runtime_id] = session
    monkeypatch.setattr(server, "_db", db)
    emitted = []
    first_started = threading.Event()
    release = threading.Event()
    model_lock = threading.Lock()
    in_model = 0
    max_in_model = 0
    calls = 0
    results = []

    def visualize(_db, session_id, *, prompt):
        nonlocal calls, in_model, max_in_model
        with model_lock:
            calls += 1
            call = calls
            in_model += 1
            max_in_model = max(max_in_model, in_model)
        first_started.set()
        assert release.wait(timeout=2)
        with model_lock:
            in_model -= 1
        return {
            "session_id": session_id,
            "artifact_id": "map.main",
            "kind": "map",
            "semantic_rev": call,
            "view_rev": 1,
            "payload": {"nodes": [{"id": f"n{call}", "label": prompt}], "edges": []},
            "view_state": {},
            "updated_by": "ambient",
        }

    monkeypatch.setattr(workbench_visualizer, "visualize_session", visualize)
    monkeypatch.setattr(
        server,
        "_emit",
        lambda event, sid, payload=None: emitted.append((event, sid, payload)),
    )

    def invoke(request_id, prompt):
        results.append(
            server._methods["workbench.visualize"](
                request_id,
                {"session_id": runtime_id, "prompt": prompt},
            )
        )

    first = threading.Thread(target=invoke, args=("first", "First"))
    second = threading.Thread(target=invoke, args=("second", "Second"))
    try:
        first.start()
        assert first_started.wait(timeout=2)
        second.start()
        deadline = time.monotonic() + 2
        while session.get("_workbench_visualize_active", 0) < 2 and time.monotonic() < deadline:
            time.sleep(0.005)

        assert session.get("_workbench_visualize_active") == 2
        assert calls == 1
        assert max_in_model == 1
    finally:
        release.set()
        first.join(timeout=2)
        second.join(timeout=2)
        server._sessions.pop(runtime_id, None)
        db.close()

    assert len(results) == 2
    assert all("error" not in result for result in results)
    assert [payload["active"] for event, _, payload in emitted if event == "artifact.visualizing"] == [
        True,
        False,
    ]
