import json

from hermes_state import SessionDB
from workbench_visualizer import visualize_session


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
