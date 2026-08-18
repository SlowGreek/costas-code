"""Trimming must be disclosed, not silent — and must still trim."""

from hermes_state import SessionDB
from hermes_state_artifacts import MAX_GRAPH_NODES, summarize_trim
import workbench_visualizer


def _oversized_graph(count: int) -> dict:
    return {
        "kind": "map",
        "nodes": [{"id": f"n{i}", "label": f"Node {i}"} for i in range(count)],
        "edges": [
            {"id": f"e{i}", "from": f"n{i}", "to": f"n{i + 1}"} for i in range(count - 1)
        ],
    }


def test_summarize_trim_reports_kept_vs_proposed():
    proposed = {"nodes": [{"id": f"n{i}"} for i in range(57)], "edges": []}
    trimmed = {"nodes": proposed["nodes"][:40], "edges": []}

    assert summarize_trim("map", proposed, trimmed) == {"shown": 40, "total": 57}


def test_summarize_trim_is_silent_when_nothing_dropped():
    payload = {"nodes": [{"id": "a"}], "edges": []}

    assert summarize_trim("map", payload, payload) is None
    assert summarize_trim("sketch", {"html": "<b/>"}, {"html": "<b/>"}) is None


def test_summarize_trim_counts_timeline_items():
    proposed = {"items": [{"id": f"i{i}"} for i in range(30)]}
    trimmed = {"items": proposed["items"][:24]}

    assert summarize_trim("timeline", proposed, trimmed) == {"shown": 24, "total": 30}


def test_visualize_records_the_trim_in_view_state(tmp_path):
    import json

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("s1", "desktop", model="test")

    artifact = workbench_visualizer.visualize_session(
        db,
        "s1",
        run_oneshot_fn=lambda **_: json.dumps(_oversized_graph(57)),
    )

    # Trimming behaviour is preserved: still degraded, never hard-failed.
    assert len(artifact["payload"]["nodes"]) == MAX_GRAPH_NODES
    # ...and now it says so, in view_state (a renderer concern, not semantics).
    assert artifact["view_state"]["trimmed"] == {"shown": MAX_GRAPH_NODES, "total": 57}
    assert "trimmed" not in artifact["payload"]
    db.close()


def test_visualize_clears_a_stale_trim_notice_on_the_next_drawing(tmp_path):
    import json

    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("s1", "desktop", model="test")

    workbench_visualizer.visualize_session(
        db, "s1", run_oneshot_fn=lambda **_: json.dumps(_oversized_graph(57))
    )
    artifact = workbench_visualizer.visualize_session(
        db, "s1", run_oneshot_fn=lambda **_: json.dumps(_oversized_graph(5))
    )

    assert len(artifact["payload"]["nodes"]) == 5
    assert "trimmed" not in artifact["view_state"]
    db.close()
