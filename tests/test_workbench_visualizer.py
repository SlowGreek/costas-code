import json

import pytest

from hermes_state import SessionDB
from hermes_state_artifacts import MAX_GRAPH_EDGES, MAX_GRAPH_NODES
from workbench_sketch import MAX_SKETCH_HTML_BYTES
from workbench_visualizer import visualize_session


def test_visualize_session_routes_a_sketch_through_sandboxed_validation(tmp_path):
    """The diagrammer can reach for `sketch` when no typed kind fits.

    Without this the sketch renderer is unreachable dead code: the model is
    never told the kind exists, so it can never emit one.
    """
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")
        db.append_realtime_transcript(
            "voice-session", item_id="u1", role="user", text="Show me a spinning cube."
        )

        html = "<canvas id='c'></canvas><script>/* three.js */</script>"

        def run_oneshot(**_kwargs):
            return json.dumps({"kind": "sketch", "html": html})

        artifact = visualize_session(db, "voice-session", run_oneshot_fn=run_oneshot)

        assert artifact["kind"] == "sketch"
        assert artifact["payload"] == {"html": html}
    finally:
        db.close()


def test_visualize_session_rejects_an_oversized_sketch(tmp_path):
    """A sketch is atomic: truncating HTML yields a broken document, so an
    over-cap sketch must fail rather than silently render garbage."""
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")

        def run_oneshot(**_kwargs):
            return json.dumps({"kind": "sketch", "html": "x" * (MAX_SKETCH_HTML_BYTES + 1)})

        with pytest.raises(Exception, match="exceeds"):
            visualize_session(db, "voice-session", run_oneshot_fn=run_oneshot)
    finally:
        db.close()


def test_visualize_session_trims_an_oversized_graph_instead_of_failing(tmp_path):
    """A too-large diagram degrades to the most connected core, never errors.

    The model routinely wants more nodes than the canvas should show. Hard
    failure surfaces to the user mid-conversation as "couldn't update the
    workbench", which reads as a broken feature rather than a bounded canvas.
    """
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session("voice-session", "desktop", model="test")
        db.append_realtime_transcript(
            "voice-session", item_id="user-1", role="user", text="Map the whole system."
        )

        # Comfortably over the cap; every node has at least one edge.
        oversized = MAX_GRAPH_NODES + 18
        nodes = [{"id": f"n{i}", "label": f"Node {i}"} for i in range(oversized)]
        edges = [
            {"id": f"e{i}", "from": f"n{i}", "to": f"n{i + 1}"}
            for i in range(oversized - 1)
        ]

        def run_oneshot(**_kwargs):
            return json.dumps({"nodes": nodes, "edges": edges})

        artifact = visualize_session(db, "voice-session", run_oneshot_fn=run_oneshot)

        payload = artifact["payload"]
        assert len(payload["nodes"]) == MAX_GRAPH_NODES
        assert len(payload["edges"]) <= MAX_GRAPH_EDGES
        kept = {node["id"] for node in payload["nodes"]}
        # Trimming must not leave edges pointing at dropped nodes.
        for edge in payload["edges"]:
            assert edge["from"] in kept and edge["to"] in kept
    finally:
        db.close()


def test_visualize_session_delegates_full_transcript_and_updates_artifact(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    captured = {}
    try:
        db.create_session("voice-session", "desktop", model="test")
        db.append_realtime_transcript(
            "voice-session", item_id="user-1", role="user", text="Voice should read shared state."
        )
        db.append_realtime_transcript(
            "voice-session", item_id="assistant-1", role="assistant", text="And the canvas renders it."
        )

        def run_oneshot(**kwargs):
            captured.update(kwargs)
            return json.dumps(
                {
                    "nodes": [
                        {"id": "voice", "label": "Voice", "kind": "agent"},
                        {"id": "state", "label": "Shared state", "kind": "state"},
                        {"id": "canvas", "label": "Canvas", "kind": "surface"},
                    ],
                    "edges": [
                        {"id": "voice-state", "from": "voice", "to": "state", "label": "reads"},
                        {"id": "state-canvas", "from": "state", "to": "canvas", "label": "renders"},
                    ],
                }
            )

        artifact = visualize_session(
            db,
            "voice-session",
            prompt="Emphasize that voice and canvas are consumers.",
            run_oneshot_fn=run_oneshot,
        )

        assert artifact["semantic_rev"] == 1
        assert captured["task"] == "ideation_workbench"
        assert captured["main_runtime"] is None
        request = json.loads(captured["user_input"])
        assert request["direction"] == "Emphasize that voice and canvas are consumers."
        assert [item["text"] for item in request["transcript"]] == [
            "Voice should read shared state.",
            "And the canvas renders it.",
        ]
        assert db.get_session_artifact("voice-session", "map.main") == artifact
    finally:
        db.close()
