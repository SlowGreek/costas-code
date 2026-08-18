"""Validation + visualizer routing for the timeline and quadrant artifact kinds."""

import json

import pytest

from hermes_state import SessionDB
from hermes_state_artifacts import (
    MAX_QUADRANT_ITEMS,
    MAX_TIMELINE_ITEMS,
    ArtifactValidationError,
    trim_payload_for_kind,
    validate_semantic_payload,
)
from workbench_visualizer import visualize_session


def _timeline(count=3):
    return {
        "items": [
            {"id": f"t{i}", "label": f"Phase {i}", "detail": "why", "order": i}
            for i in range(count)
        ]
    }


def _quadrant(count=3):
    return {
        "axes": {
            "x": {"low": "cheap", "high": "costly"},
            "y": {"low": "low impact", "high": "high impact"},
        },
        "items": [
            {"id": f"q{i}", "label": f"Idea {i}", "x": (i % 11) / 10, "y": 0.5}
            for i in range(count)
        ],
    }


# --- map stays byte-for-byte backward compatible -----------------------------


def test_map_validation_is_unchanged_and_is_the_default_kind():
    graph = {
        "nodes": [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}],
        "edges": [{"id": "e", "from": "a", "to": "b"}],
    }
    validate_semantic_payload(graph)
    validate_semantic_payload(graph, "map")
    # An unrecognised kind must degrade to map rather than reject.
    validate_semantic_payload(graph, "totally-unknown")


def test_map_still_rejects_renderer_geometry():
    with pytest.raises(ArtifactValidationError):
        validate_semantic_payload(
            {"nodes": [{"id": "a", "label": "A", "x": 1}], "edges": []}, "map"
        )


# --- timeline ----------------------------------------------------------------


def test_timeline_accepts_the_contract_shape():
    validate_semantic_payload(_timeline(), "timeline")
    # detail and order are both optional.
    validate_semantic_payload({"items": [{"id": "a", "label": "Kickoff"}]}, "timeline")


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"items": "nope"},
        {"items": [{"label": "no id"}]},
        {"items": [{"id": "a"}]},
        {"items": [{"id": "a", "label": "A", "order": "first"}]},
        {"items": [{"id": "a", "label": "A"}, {"id": "a", "label": "dup"}]},
        {"items": [{"id": "a", "label": "A", "x": 0.2}]},
    ],
)
def test_timeline_rejects_malformed_payloads(payload):
    with pytest.raises(ArtifactValidationError):
        validate_semantic_payload(payload, "timeline")


def test_timeline_trims_instead_of_failing():
    oversized = _timeline(MAX_TIMELINE_ITEMS + 9)
    trimmed = trim_payload_for_kind("timeline", oversized)
    assert len(trimmed["items"]) == MAX_TIMELINE_ITEMS
    # Earliest ordered steps survive; ordering is preserved.
    assert [item["order"] for item in trimmed["items"]] == list(range(MAX_TIMELINE_ITEMS))
    validate_semantic_payload(trimmed, "timeline")


# --- quadrant ----------------------------------------------------------------


def test_quadrant_accepts_semantic_coordinates():
    validate_semantic_payload(_quadrant(), "quadrant")
    validate_semantic_payload(
        {
            "axes": {"x": {"low": "l", "high": "h"}, "y": {"low": "l", "high": "h"}},
            "items": [{"id": "a", "label": "A", "x": 0, "y": 1}],
        },
        "quadrant",
    )


@pytest.mark.parametrize(
    "bad_item",
    [
        {"id": "a", "label": "A"},
        {"id": "a", "label": "A", "x": 0.5},
        {"id": "a", "label": "A", "x": 1.5, "y": 0.5},
        {"id": "a", "label": "A", "x": -0.1, "y": 0.5},
        {"id": "a", "label": "A", "x": "0.5", "y": 0.5},
        {"id": "a", "label": "A", "x": True, "y": 0.5},
        {"id": "a", "label": "A", "x": 0.5, "y": 0.5, "width": 20},
    ],
)
def test_quadrant_rejects_bad_coordinates_and_real_geometry(bad_item):
    payload = _quadrant(0)
    payload["items"] = [bad_item]
    with pytest.raises(ArtifactValidationError):
        validate_semantic_payload(payload, "quadrant")


@pytest.mark.parametrize(
    "axes",
    [
        None,
        {"x": {"low": "l", "high": "h"}},
        {"x": {"low": "l"}, "y": {"low": "l", "high": "h"}},
        {"x": "left-right", "y": {"low": "l", "high": "h"}},
    ],
)
def test_quadrant_requires_both_named_axes(axes):
    payload = {"items": []}
    if axes is not None:
        payload["axes"] = axes
    with pytest.raises(ArtifactValidationError):
        validate_semantic_payload(payload, "quadrant")


def test_quadrant_trims_instead_of_failing():
    oversized = _quadrant(MAX_QUADRANT_ITEMS + 7)
    trimmed = trim_payload_for_kind("quadrant", oversized)
    assert len(trimmed["items"]) == MAX_QUADRANT_ITEMS
    validate_semantic_payload(trimmed, "quadrant")


# --- visualizer kind routing --------------------------------------------------


def _session(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session("voice-session", "desktop", model="test")
    db.append_realtime_transcript(
        "voice-session", item_id="user-1", role="user", text="Lay out the phases."
    )
    return db


def _visualize(db, reply, **kwargs):
    return visualize_session(
        db, "voice-session", run_oneshot_fn=lambda **_k: json.dumps(reply), **kwargs
    )


def test_visualize_creates_a_timeline_when_the_model_picks_one(tmp_path):
    db = _session(tmp_path)
    try:
        artifact = _visualize(db, {"kind": "timeline", **_timeline()})
        assert artifact["kind"] == "timeline"
        assert [item["id"] for item in artifact["payload"]["items"]] == ["t0", "t1", "t2"]
        assert "kind" not in artifact["payload"]
    finally:
        db.close()


def test_visualize_creates_a_quadrant_with_semantic_positions(tmp_path):
    db = _session(tmp_path)
    try:
        artifact = _visualize(db, {"kind": "quadrant", **_quadrant()})
        assert artifact["kind"] == "quadrant"
        assert artifact["payload"]["axes"]["x"]["high"] == "costly"
        assert artifact["payload"]["items"][1]["x"] == pytest.approx(0.1)
    finally:
        db.close()


def test_visualize_defaults_to_map_when_kind_is_absent_or_unknown(tmp_path):
    db = _session(tmp_path)
    try:
        graph = {"nodes": [{"id": "a", "label": "A"}], "edges": []}
        artifact = _visualize(db, graph)
        assert artifact["kind"] == "map"

        artifact = _visualize(db, {"kind": "hologram", **graph})
        assert artifact["kind"] == "map"
        assert artifact["payload"]["nodes"][0]["id"] == "a"
    finally:
        db.close()


def test_visualize_switches_kind_on_an_existing_artifact(tmp_path):
    db = _session(tmp_path)
    try:
        first = _visualize(db, {"nodes": [{"id": "a", "label": "A"}], "edges": []})
        assert first["kind"] == "map"

        second = _visualize(db, {"kind": "timeline", **_timeline(2)})
        assert second["kind"] == "timeline"
        assert second["semantic_rev"] == 2
        assert db.get_session_artifact("voice-session", "map.main") == second
    finally:
        db.close()


def test_visualize_trims_an_oversized_timeline_instead_of_failing(tmp_path):
    db = _session(tmp_path)
    try:
        artifact = _visualize(
            db, {"kind": "timeline", **_timeline(MAX_TIMELINE_ITEMS + 12)}
        )
        assert len(artifact["payload"]["items"]) == MAX_TIMELINE_ITEMS
    finally:
        db.close()


def test_visualize_trims_an_oversized_quadrant_instead_of_failing(tmp_path):
    db = _session(tmp_path)
    try:
        artifact = _visualize(
            db, {"kind": "quadrant", **_quadrant(MAX_QUADRANT_ITEMS + 12)}
        )
        assert len(artifact["payload"]["items"]) == MAX_QUADRANT_ITEMS
    finally:
        db.close()
