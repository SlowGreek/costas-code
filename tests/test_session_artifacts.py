"""Behavior contracts for session-scoped ideation artifacts."""

import pytest

from hermes_state import SCHEMA_VERSION, SessionDB


def test_artifact_table_advances_schema_version(tmp_path):
    assert SCHEMA_VERSION == 27
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        stored = db._conn.execute("SELECT version FROM schema_version").fetchone()[0]
        assert stored == 27
    finally:
        db.close()


def test_new_session_has_no_artifacts(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(session_id="voice-session", source="desktop", model="test")

        assert db.list_session_artifacts("voice-session") == []
    finally:
        db.close()


def test_created_artifact_persists_across_reopen(tmp_path):
    path = tmp_path / "state.db"
    db = SessionDB(db_path=path)
    try:
        db.create_session(session_id="voice-session", source="desktop", model="test")
        created = db.create_session_artifact(
            "voice-session",
            "map.main",
            kind="map",
            payload={"nodes": [], "edges": []},
            view_state={"positions": {}, "pinned": [], "zoom": 1},
            updated_by="ambient",
        )
        assert created["artifact_id"] == "map.main"
        assert created["semantic_rev"] == 1
        assert created["view_rev"] == 1
    finally:
        db.close()

    reopened = SessionDB(db_path=path)
    try:
        assert reopened.list_session_artifacts("voice-session") == [created]
    finally:
        reopened.close()


def test_semantic_update_increments_only_semantic_revision(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(session_id="voice-session", source="desktop", model="test")
        db.create_session_artifact(
            "voice-session",
            "map.main",
            kind="map",
            payload={"nodes": [], "edges": []},
            view_state={"positions": {"core": {"x": 10, "y": 20}}, "pinned": ["core"]},
            updated_by="ambient",
        )

        updated = db.update_artifact_semantics(
            "voice-session",
            "map.main",
            payload={
                "nodes": [{"id": "core", "label": "Core", "kind": "component"}],
                "edges": [],
            },
            expected_rev=1,
            updated_by="ambient",
        )

        assert updated["semantic_rev"] == 2
        assert updated["view_rev"] == 1
        assert updated["view_state"] == {
            "positions": {"core": {"x": 10, "y": 20}},
            "pinned": ["core"],
        }
    finally:
        db.close()


def test_stale_semantic_revision_is_rejected_without_mutation(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(session_id="voice-session", source="desktop", model="test")
        original = db.create_session_artifact(
            "voice-session",
            "map.main",
            kind="map",
            payload={"nodes": [], "edges": []},
            view_state={},
            updated_by="ambient",
        )
        db.update_artifact_semantics(
            "voice-session",
            "map.main",
            payload={"nodes": [{"id": "one", "label": "One"}], "edges": []},
            expected_rev=1,
            updated_by="ambient",
        )

        with pytest.raises(Exception) as caught:
            db.update_artifact_semantics(
                "voice-session",
                "map.main",
                payload={"nodes": [{"id": "stale", "label": "Stale"}], "edges": []},
                expected_rev=1,
                updated_by="ambient",
            )

        assert caught.type.__name__ == "ArtifactRevisionConflict"
        current = db.list_session_artifacts("voice-session")[0]
        assert current["semantic_rev"] == original["semantic_rev"] + 1
        assert current["payload"]["nodes"] == [{"id": "one", "label": "One"}]
    finally:
        db.close()


def test_view_update_increments_only_view_revision(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(session_id="voice-session", source="desktop", model="test")
        db.create_session_artifact(
            "voice-session",
            "map.main",
            kind="map",
            payload={"nodes": [{"id": "core", "label": "Core"}], "edges": []},
            view_state={"positions": {}, "pinned": []},
            updated_by="ambient",
        )

        updated = db.update_artifact_view_state(
            "voice-session",
            "map.main",
            view_state={"positions": {"core": {"x": 10, "y": 20}}, "pinned": ["core"]},
            expected_rev=1,
            updated_by="renderer",
        )

        assert updated["view_rev"] == 2
        assert updated["semantic_rev"] == 1
        assert updated["payload"] == {
            "nodes": [{"id": "core", "label": "Core"}],
            "edges": [],
        }
    finally:
        db.close()


def test_semantic_payload_rejects_renderer_geometry(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(session_id="voice-session", source="desktop", model="test")

        with pytest.raises(Exception) as caught:
            db.create_session_artifact(
                "voice-session",
                "map.main",
                kind="map",
                payload={
                    "nodes": [
                        {"id": "core", "label": "Core", "kind": "component", "x": 10, "y": 20}
                    ],
                    "edges": [],
                },
                view_state={},
                updated_by="ambient",
            )

        assert caught.type.__name__ == "ArtifactValidationError"
        assert "geometry" in str(caught.value)
        assert db.list_session_artifacts("voice-session") == []
    finally:
        db.close()


def test_get_artifact_returns_none_or_the_requested_artifact(tmp_path):
    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.create_session(session_id="voice-session", source="desktop", model="test")
        assert db.get_session_artifact("voice-session", "map.main") is None

        created = db.create_session_artifact(
            "voice-session",
            "map.main",
            kind="map",
            payload={"nodes": [], "edges": []},
            view_state={},
            updated_by="ambient",
        )

        assert db.get_session_artifact("voice-session", "map.main") == created
    finally:
        db.close()
