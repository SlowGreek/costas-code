"""Surgical (no-model) artifact edits: apply, validate, and refuse."""

import pytest

from hermes_state_artifacts import (
    GEOMETRY_KEYS,
    MAX_GRAPH_EDGES,
    SurgicalEditError,
    apply_surgical_edit,
    validate_semantic_payload,
)


def graph():
    return {
        "nodes": [
            {"id": "a", "label": "Alpha", "kind": "system"},
            {"id": "b", "label": "Beta"},
            {"id": "c", "label": "Gamma"},
        ],
        "edges": [
            {"id": "e1", "from": "a", "to": "b", "label": "feeds"},
            {"id": "e2", "from": "b", "to": "c"},
        ],
    }


def test_rename_keeps_id_and_edges():
    out = apply_surgical_edit(graph(), {"op": "rename", "node_id": "a", "label": "Planner"})
    assert out["nodes"][0] == {"id": "a", "label": "Planner", "kind": "system"}
    assert out["edges"] == graph()["edges"]
    validate_semantic_payload(out, "map")


def test_remove_drops_node_and_dangling_edges():
    out = apply_surgical_edit(graph(), {"op": "remove", "node_id": "b"})
    assert [n["id"] for n in out["nodes"]] == ["a", "c"]
    assert out["edges"] == []
    validate_semantic_payload(out, "map")


def test_connect_adds_one_edge_with_unique_id():
    out = apply_surgical_edit(graph(), {"op": "connect", "from_id": "a", "to_id": "c", "label": "blocks"})
    assert out["edges"][-1] == {"id": "e-a-c", "from": "a", "to": "c", "label": "blocks"}
    again = apply_surgical_edit(out, {"op": "connect", "from_id": "a", "to_id": "c"})
    assert again["edges"][-1]["id"] == "e-a-c-2"
    validate_semantic_payload(again, "map")


def test_disconnect_removes_one_edge():
    out = apply_surgical_edit(graph(), {"op": "disconnect", "edge_id": "e1"})
    assert [e["id"] for e in out["edges"]] == ["e2"]
    validate_semantic_payload(out, "map")


def test_input_is_never_mutated():
    original = graph()
    apply_surgical_edit(original, {"op": "remove", "node_id": "a"})
    assert original == graph()


@pytest.mark.parametrize(
    "edit",
    [
        {"op": "rename", "node_id": "zz", "label": "x"},
        {"op": "rename", "node_id": "a", "label": "   "},
        {"op": "remove", "node_id": "zz"},
        {"op": "disconnect", "edge_id": "zz"},
        {"op": "connect", "from_id": "a", "to_id": "zz"},
        {"op": "connect", "from_id": "a", "to_id": "a"},
        {"op": "nuke", "node_id": "a"},
        {},
    ],
)
def test_bad_edits_are_refused(edit):
    with pytest.raises(SurgicalEditError):
        apply_surgical_edit(graph(), edit)


def test_connect_respects_the_edge_cap():
    payload = {
        "nodes": [{"id": f"n{i}", "label": f"N{i}"} for i in range(3)],
        "edges": [
            {"id": f"e{i}", "from": "n0", "to": "n1"} for i in range(MAX_GRAPH_EDGES)
        ],
    }
    with pytest.raises(SurgicalEditError):
        apply_surgical_edit(payload, {"op": "connect", "from_id": "n0", "to_id": "n2"})


def test_surgical_result_never_carries_renderer_geometry():
    out = apply_surgical_edit(graph(), {"op": "connect", "from_id": "a", "to_id": "c"})
    for item in out["nodes"] + out["edges"]:
        assert not GEOMETRY_KEYS.intersection(item)
