"""Durable typed external-role bindings and visible delegate-child projection."""

import json
import sqlite3

import pytest

from hermes_state import (
    EXTERNAL_ROLE_SESSION_BINDING_VERSION,
    MAX_DELEGATE_CHILDREN,
    MAX_DELEGATE_PARENT_IDS,
    ExternalRoleSessionAuthority,
    ExternalRoleSessionRole,
    SessionDB,
)


@pytest.fixture
def db(tmp_path):
    store = SessionDB(db_path=tmp_path / "state.db")
    yield store
    store.close()


def _bind(
    db: SessionDB,
    session_id: str,
    *,
    external_id: str,
    external_parent_id: str | None,
    role: ExternalRoleSessionRole | str = ExternalRoleSessionRole.ENGINEER,
):
    return db.create_external_role_session_binding(
        session_id,
        namespace="agent-experiments",
        external_role_session_id=external_id,
        external_parent_role_session_id=external_parent_id,
        role=role,
        authority=ExternalRoleSessionAuthority.OBSERVE,
        version=EXTERNAL_ROLE_SESSION_BINDING_VERSION,
    )


def test_schema_migrates_existing_database_without_touching_session_rows(tmp_path):
    db_path = tmp_path / "state.db"
    db = SessionDB(db_path=db_path)
    db.create_session("existing", "cli", model_config={"provider_setting": "kept"})
    db._conn.execute("UPDATE schema_version SET version = 23")
    db._conn.commit()
    db.close()

    migrated = SessionDB(db_path=db_path)
    try:
        table = migrated._conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' "
            "AND name='external_role_session_bindings'"
        ).fetchone()
        assert table is not None
        assert migrated._conn.execute(
            "SELECT version FROM schema_version"
        ).fetchone()[0] >= 25
        row = migrated.get_session("existing")
        assert row is not None
        assert json.loads(row["model_config"]) == {"provider_setting": "kept"}
        assert migrated.get_external_role_session_binding("existing") is None
    finally:
        migrated.close()


def test_sidekick_is_a_closed_content_free_durable_role(db):
    db.create_session("sidekick", "desktop")
    expected = {
        "durable_session_id": "sidekick",
        "namespace": "agent-experiments",
        "external_role_session_id": "sidekick-role-session",
        "external_parent_role_session_id": None,
        "role": "sidekick",
        "authority": "observe",
        "version": 1,
    }
    assert _bind(
        db,
        "sidekick",
        external_id="sidekick-role-session",
        external_parent_id=None,
        role=ExternalRoleSessionRole.SIDEKICK,
    ) == expected
    assert db.get_external_role_session_binding("sidekick") == expected
    table_sql = db._conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' "
        "AND name='external_role_session_bindings'"
    ).fetchone()[0]
    assert "'sidekick'" in table_sql


def test_create_get_delete_binding_is_separate_strict_and_content_free(db):
    db.create_session("parent", "cli")
    db.create_session(
        "child",
        "cli",
        parent_session_id="parent",
        model="private-provider-model",
        model_config={"_delegate_from": "parent", "provider_thread_id": "secret"},
    )

    expected = {
        "durable_session_id": "child",
        "namespace": "agent-experiments",
        "external_role_session_id": "opaque-engineer-1",
        "external_parent_role_session_id": "opaque-em-1",
        "role": "engineer",
        "authority": "observe",
        "version": 1,
    }
    assert _bind(
        db,
        "child",
        external_id="opaque-engineer-1",
        external_parent_id="opaque-em-1",
    ) == expected
    assert db.get_external_role_session_binding("child") == expected

    binding_columns = {
        row["name"]
        for row in db._conn.execute(
            "PRAGMA table_info(external_role_session_bindings)"
        ).fetchall()
    }
    assert binding_columns == set(expected)
    assert not {
        "provider_id",
        "runtime_id",
        "capability",
        "lease",
        "prompt",
        "model_config",
    } & binding_columns
    child = db.get_session("child")
    assert child is not None
    assert json.loads(child["model_config"])["provider_thread_id"] == "secret"

    assert db.delete_external_role_session_binding("child") is True
    assert db.delete_external_role_session_binding("child") is False
    assert db.get_external_role_session_binding("child") is None
    assert db.get_session("child") is not None


@pytest.mark.parametrize(
    ("overrides", "error_type"),
    [
        ({"durable_session_id": "missing"}, ValueError),
        ({"namespace": ""}, ValueError),
        ({"namespace": " agent-experiments"}, ValueError),
        ({"namespace": "agent experiments"}, ValueError),
        ({"external_role_session_id": ""}, ValueError),
        ({"external_parent_role_session_id": "bad\nparent"}, ValueError),
        ({"role": "manager"}, ValueError),
        ({"authority": "control"}, ValueError),
        ({"version": 2}, ValueError),
        ({"version": True}, TypeError),
    ],
)
def test_create_binding_rejects_open_or_malformed_values(db, overrides, error_type):
    db.create_session("child", "cli")
    params = {
        "durable_session_id": "child",
        "namespace": "agent-experiments",
        "external_role_session_id": "opaque-child",
        "external_parent_role_session_id": "opaque-parent",
        "role": "engineer",
        "authority": "observe",
        "version": 1,
    }
    params.update(overrides)
    with pytest.raises(error_type):
        db.create_external_role_session_binding(**params)


def test_duplicate_durable_or_external_identity_is_rejected(db):
    db.create_session("child-a", "cli")
    db.create_session("child-b", "cli")
    _bind(
        db,
        "child-a",
        external_id="opaque-child-a",
        external_parent_id="opaque-parent",
    )

    with pytest.raises(ValueError, match="already exists"):
        _bind(
            db,
            "child-a",
            external_id="opaque-child-rebound",
            external_parent_id="opaque-parent",
        )
    with pytest.raises(ValueError, match="already exists"):
        _bind(
            db,
            "child-b",
            external_id="opaque-child-a",
            external_parent_id="opaque-parent",
        )


def test_list_delegate_children_only_returns_bound_direct_children_allowlist(db):
    db.create_session("parent", "cli")
    db.create_session("other-parent", "cli")
    db.create_session(
        "bound-child",
        "cli",
        parent_session_id="parent",
        model="private-model",
        model_config={
            "_delegate_from": "parent",
            "provider_id": "must-not-project",
            "capability": "must-not-project",
        },
    )
    db.create_session(
        "ordinary-hidden-child",
        "cli",
        parent_session_id="parent",
        model_config={"_delegate_from": "parent"},
    )
    db.create_session(
        "branch",
        "cli",
        parent_session_id="parent",
        model_config={"_branched_from": "parent"},
    )
    db.create_session(
        "other-child",
        "cli",
        parent_session_id="other-parent",
        model_config={"_delegate_from": "other-parent"},
    )
    _bind(
        db,
        "bound-child",
        external_id="opaque-engineer",
        external_parent_id="opaque-em",
    )
    _bind(
        db,
        "other-child",
        external_id="opaque-other",
        external_parent_id="opaque-other-parent",
    )
    _bind(
        db,
        "branch",
        external_id="opaque-branch",
        external_parent_id="opaque-em",
        role=ExternalRoleSessionRole.EM,
    )

    rows = db.list_delegate_children(["parent"], limit=10)
    assert rows == [
        {
            "durable_session_id": "bound-child",
            "parent_durable_session_id": "parent",
            "lineage_root_id": "parent",
            "namespace": "agent-experiments",
            "external_role_session_id": "opaque-engineer",
            "external_parent_role_session_id": "opaque-em",
            "role": "engineer",
            "authority": "observe",
            "version": 1,
        }
    ]
    assert set(rows[0]) == {
        "durable_session_id",
        "parent_durable_session_id",
        "lineage_root_id",
        "namespace",
        "external_role_session_id",
        "external_parent_role_session_id",
        "role",
        "authority",
        "version",
    }


def test_list_delegate_children_projects_compression_tip_and_stable_child_lineage(db):
    db.create_session("parent", "cli")
    db.create_session(
        "child-root",
        "cli",
        parent_session_id="parent",
        model_config={"_delegate_from": "parent"},
    )
    _bind(
        db,
        "child-root",
        external_id="opaque-engineer",
        external_parent_id="opaque-em",
    )
    db.end_session("child-root", "compression")
    db.create_session("child-mid", "cli", parent_session_id="child-root")
    db.end_session("child-mid", "compression")
    db.create_session("child-tip", "cli", parent_session_id="child-mid")

    rows = db.list_delegate_children(["parent"])
    assert len(rows) == 1
    assert rows[0]["durable_session_id"] == "child-tip"
    assert rows[0]["parent_durable_session_id"] == "parent"
    assert rows[0]["lineage_root_id"] == "parent"
    assert rows[0]["external_role_session_id"] == "opaque-engineer"


def test_list_delegate_children_is_bounded_and_validates_every_parent(db):
    assert db.list_delegate_children([]) == []
    with pytest.raises(TypeError):
        db.list_delegate_children(("parent",))  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="parent_ids exceeds"):
        db.list_delegate_children([f"p-{index}" for index in range(MAX_DELEGATE_PARENT_IDS + 1)])
    with pytest.raises(ValueError, match="limit must be between"):
        db.list_delegate_children(["parent"], limit=0)
    with pytest.raises(ValueError, match="limit must be between"):
        db.list_delegate_children(["parent"], limit=MAX_DELEGATE_CHILDREN + 1)
    with pytest.raises(ValueError, match="parent_id"):
        db.list_delegate_children(["parent", " bad"])


def test_projection_does_not_change_existing_list_or_count_behavior(db):
    db.create_session("parent", "cli")
    db.create_session(
        "child",
        "cli",
        parent_session_id="parent",
        model_config={"_delegate_from": "parent"},
    )
    list_before = [row["id"] for row in db.list_sessions_rich()]
    raw_list_before = [
        row["id"]
        for row in db.list_sessions_rich(
            include_children=True,
            project_compression_tips=False,
        )
    ]
    count_before = db.session_count(exclude_children=True)
    raw_count_before = db.session_count()

    _bind(
        db,
        "child",
        external_id="opaque-engineer",
        external_parent_id="opaque-em",
    )

    assert [row["id"] for row in db.list_sessions_rich()] == list_before == ["parent"]
    assert [
        row["id"]
        for row in db.list_sessions_rich(
            include_children=True,
            project_compression_tips=False,
        )
    ] == raw_list_before
    assert db.session_count(exclude_children=True) == count_before == 1
    assert db.session_count() == raw_count_before == 2
    assert db.list_delegate_children(["parent"])[0]["durable_session_id"] == "child"


def test_binding_projection_is_available_from_read_only_session_db(tmp_path):
    db_path = tmp_path / "state.db"
    writer = SessionDB(db_path=db_path)
    writer.create_session("parent", "cli")
    writer.create_session(
        "child",
        "cli",
        parent_session_id="parent",
        model_config={"_delegate_from": "parent"},
    )
    _bind(
        writer,
        "child",
        external_id="opaque-engineer",
        external_parent_id="opaque-em",
    )
    writer.close()

    reader = SessionDB(db_path=db_path, read_only=True)
    try:
        assert reader.get_external_role_session_binding("child") is not None
        assert reader.list_delegate_children(["parent"]) == [
            {
                "durable_session_id": "child",
                "parent_durable_session_id": "parent",
                "lineage_root_id": "parent",
                "namespace": "agent-experiments",
                "external_role_session_id": "opaque-engineer",
                "external_parent_role_session_id": "opaque-em",
                "role": "engineer",
                "authority": "observe",
                "version": 1,
            }
        ]
    finally:
        reader.close()


def test_binding_cascades_with_existing_delegate_delete_semantics(db):
    db.create_session("parent", "cli")
    db.create_session(
        "delegate",
        "cli",
        parent_session_id="parent",
        model_config={"_delegate_from": "parent"},
    )
    db.create_session(
        "branch",
        "cli",
        parent_session_id="parent",
        model_config={"_branched_from": "parent"},
    )
    _bind(
        db,
        "delegate",
        external_id="opaque-engineer",
        external_parent_id="opaque-em",
    )
    _bind(
        db,
        "branch",
        external_id="opaque-branch",
        external_parent_id="opaque-em",
        role=ExternalRoleSessionRole.EM,
    )

    assert db.delete_session("parent") is True
    assert db.get_session("delegate") is None
    assert db.get_external_role_session_binding("delegate") is None
    assert db.get_session("branch") is not None
    assert db.get_external_role_session_binding("branch") is not None


def test_binding_cascades_with_bulk_delegate_delete_semantics(db):
    db.create_session("parent", "cli")
    db.create_session(
        "delegate",
        "cli",
        parent_session_id="parent",
        model_config={"_delegate_from": "parent"},
    )
    _bind(
        db,
        "delegate",
        external_id="opaque-engineer",
        external_parent_id="opaque-em",
    )

    assert db.delete_sessions(["parent"]) == 1
    assert db.get_session("delegate") is None
    assert db.get_external_role_session_binding("delegate") is None


def test_database_constraints_refuse_invalid_rows_even_if_api_is_bypassed(db):
    db.create_session("child", "cli")
    with pytest.raises(sqlite3.IntegrityError):
        db._conn.execute(
            """INSERT INTO external_role_session_bindings (
                   durable_session_id, namespace, external_role_session_id,
                   external_parent_role_session_id, role, authority, version
               ) VALUES (?, ?, ?, ?, ?, ?, ?)""",
            ("child", "agent-experiments", "opaque", None, "admin", "observe", 1),
        )
