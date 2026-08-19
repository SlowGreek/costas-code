"""Incremental redraws: the diagrammer emits a diff, not a whole new graph.

A full regenerate measured ~9s against the live app while a surgical edit
measured 13ms — a 690x gap that is structural, not tuning. Letting the
diagrammer emit ops instead of a whole payload puts ordinary updates on the
fast path.

The danger is corruption: a diff applied to the wrong base silently produces a
wrong drawing, where a bad full payload at least fails validation. These tests
pin the safety properties, not just the happy path.
"""

import pytest

from hermes_state_artifacts import (
    GraphOpsError,
    apply_graph_ops,
)


BASE = {
    "nodes": [
        {"id": "voice", "label": "Voice", "kind": "agent"},
        {"id": "canvas", "label": "Canvas", "kind": "surface"},
    ],
    "edges": [{"id": "voice-canvas", "from": "voice", "to": "canvas", "label": "draws"}],
}


def test_add_node_appends_without_touching_the_rest():
    out = apply_graph_ops(BASE, [{"op": "add_node", "id": "memory", "label": "Memory", "kind": "store"}])

    assert [n["id"] for n in out["nodes"]] == ["voice", "canvas", "memory"]
    # Existing nodes must be untouched — identity is what deixis depends on.
    assert out["nodes"][0] == BASE["nodes"][0]
    assert out["edges"] == BASE["edges"]


def test_ops_never_mutate_the_input():
    """A partially-applied diff must never leak back into the live artifact."""
    before = [dict(n) for n in BASE["nodes"]]

    apply_graph_ops(BASE, [{"op": "add_node", "id": "x", "label": "X"}])

    assert BASE["nodes"] == before


def test_a_failing_op_aborts_the_whole_diff():
    """All-or-nothing. A half-applied diff is a corrupted drawing."""
    ops = [
        {"op": "add_node", "id": "memory", "label": "Memory"},
        {"op": "rename", "node_id": "nonexistent", "label": "Nope"},
    ]

    with pytest.raises(GraphOpsError, match="unknown node"):
        apply_graph_ops(BASE, ops)


def test_ops_apply_in_order_so_later_ops_see_earlier_ones():
    """Adding a node then connecting to it must work in ONE diff."""
    out = apply_graph_ops(
        BASE,
        [
            {"op": "add_node", "id": "memory", "label": "Memory"},
            {"op": "connect", "from_id": "canvas", "to_id": "memory", "label": "persists"},
        ],
    )

    assert "memory" in [n["id"] for n in out["nodes"]]
    assert any(e["from"] == "canvas" and e["to"] == "memory" for e in out["edges"])


def test_remove_node_takes_its_edges_with_it():
    out = apply_graph_ops(BASE, [{"op": "remove", "node_id": "canvas"}])

    assert [n["id"] for n in out["nodes"]] == ["voice"]
    # A dangling edge would fail validation downstream.
    assert out["edges"] == []


def test_rename_preserves_id_and_edges():
    out = apply_graph_ops(BASE, [{"op": "rename", "node_id": "voice", "label": "Realtime Voice"}])

    voice = next(n for n in out["nodes"] if n["id"] == "voice")
    assert voice["label"] == "Realtime Voice"
    assert voice["kind"] == "agent"
    assert out["edges"] == BASE["edges"]


def test_add_node_rejects_a_duplicate_id():
    """Silently overwriting would make the model's diff lie about the result."""
    with pytest.raises(GraphOpsError, match="already exists"):
        apply_graph_ops(BASE, [{"op": "add_node", "id": "voice", "label": "Duplicate"}])


def test_ops_respect_the_node_cap():
    big = {"nodes": [{"id": f"n{i}", "label": f"N{i}"} for i in range(40)], "edges": []}

    with pytest.raises(GraphOpsError, match="40"):
        apply_graph_ops(big, [{"op": "add_node", "id": "one-too-many", "label": "X"}])


def test_an_empty_diff_is_a_no_op_not_an_error():
    """The model saying 'nothing changed' must not blank the canvas."""
    out = apply_graph_ops(BASE, [])

    assert out["nodes"] == BASE["nodes"]
    assert out["edges"] == BASE["edges"]


def test_unknown_op_is_rejected_rather_than_ignored():
    """Ignoring would apply a partial diff while reporting success."""
    with pytest.raises(GraphOpsError, match="unsupported"):
        apply_graph_ops(BASE, [{"op": "teleport", "node_id": "voice"}])


def test_ops_require_a_graph_payload():
    """A timeline has no nodes; a diff against it is a category error."""
    with pytest.raises(GraphOpsError, match="graph"):
        apply_graph_ops({"items": []}, [{"op": "add_node", "id": "x", "label": "X"}])
