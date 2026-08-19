"""Artifact history: 'go back' to the previous view.

Every redraw overwrites `session_artifacts` in place, so before this there was
nothing to go back TO. The user asked for it directly: "it also needs a concept
of history so we can say go back and it can switch back to the previous view".
"""

import pathlib
import tempfile

import pytest

from hermes_state import SessionDB


@pytest.fixture
def db():
    database = SessionDB(db_path=pathlib.Path(tempfile.mkdtemp()) / "state.db")
    database.create_session("s", "desktop", model="test")
    database.create_session_artifact(
        "s",
        "map.main",
        kind="map",
        payload={"nodes": [{"id": "a", "label": "A"}], "edges": []},
        view_state={},
        updated_by="test",
    )
    try:
        yield database
    finally:
        database.close()


def _map(db, *labels, expected_rev):
    return db.update_artifact_semantics(
        "s",
        "map.main",
        payload={"nodes": [{"id": lbl.lower(), "label": lbl} for lbl in labels], "edges": []},
        expected_rev=expected_rev,
        updated_by="ambient",
        kind="map",
    )


def test_a_redraw_records_the_previous_version(db):
    """Overwriting is fine; losing the old version is not."""
    _map(db, "B", expected_rev=1)

    history = db.list_artifact_history("s", "map.main")

    assert len(history) == 1
    assert history[0]["semantic_rev"] == 1
    assert [n["label"] for n in history[0]["payload"]["nodes"]] == ["A"]


def test_go_back_restores_the_previous_view(db):
    """'Go back' must return the actual previous drawing, not a re-derivation."""
    _map(db, "B", expected_rev=1)
    current = _map(db, "C", expected_rev=2)

    assert [n["label"] for n in current["payload"]["nodes"]] == ["C"]

    restored = db.restore_artifact_version("s", "map.main", expected_rev=current["semantic_rev"])

    assert [n["label"] for n in restored["payload"]["nodes"]] == ["B"]
    # Going back is itself a new revision — never rewrite history to move within it.
    assert restored["semantic_rev"] == 4


def test_going_back_twice_walks_further_back(db):
    _map(db, "B", expected_rev=1)
    cur = _map(db, "C", expected_rev=2)

    cur = db.restore_artifact_version("s", "map.main", expected_rev=cur["semantic_rev"])
    assert [n["label"] for n in cur["payload"]["nodes"]] == ["B"]

    cur = db.restore_artifact_version("s", "map.main", expected_rev=cur["semantic_rev"])
    assert [n["label"] for n in cur["payload"]["nodes"]] == ["A"]


def test_go_back_carries_the_kind_not_just_the_payload(db):
    """A timeline going back to a map must restore the KIND too.

    Restoring a timeline payload while the row still says 'map' would hand the
    renderer a payload with no nodes — exactly the crash that took down the
    whole pane earlier today.
    """
    db.update_artifact_semantics(
        "s",
        "map.main",
        payload={"items": [{"id": "p1", "label": "Phase 1", "order": 0}]},
        expected_rev=1,
        updated_by="ambient",
        kind="timeline",
    )

    restored = db.restore_artifact_version("s", "map.main", expected_rev=2)

    assert restored["kind"] == "map"
    assert [n["label"] for n in restored["payload"]["nodes"]] == ["A"]


def test_go_back_with_no_history_fails_cleanly(db):
    """Nothing to go back to must not corrupt or blank the canvas."""
    with pytest.raises(Exception, match="no earlier version"):
        db.restore_artifact_version("s", "map.main", expected_rev=1)

    current = db.get_session_artifact("s", "map.main")
    assert [n["label"] for n in current["payload"]["nodes"]] == ["A"]


def test_history_is_bounded(db):
    """An hour of ideation must not grow unboundedly in SQLite."""
    rev = 1
    for i in range(40):
        rev = _map(db, f"N{i}", expected_rev=rev)["semantic_rev"]

    history = db.list_artifact_history("s", "map.main")

    assert len(history) <= 20
    # The bound must drop the OLDEST, keeping what "go back" will actually reach.
    assert history[0]["semantic_rev"] > 1


def test_view_only_changes_do_not_pollute_history(db):
    """Pointing at a node is not a version of the drawing.

    Without this, `focus` and drag-persist would flood history and 'go back'
    would return the same picture with a different highlight.
    """
    db.update_artifact_view_state(
        "s", "map.main", view_state={"focus": "a"}, expected_rev=1, updated_by="voice-focus"
    )

    assert db.list_artifact_history("s", "map.main") == []
