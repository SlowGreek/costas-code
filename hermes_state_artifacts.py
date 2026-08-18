"""Session-scoped ideation artifact persistence for ``SessionDB``.

This is a plain mixin: the host provides ``_read_ctx`` and ``_execute_write``.
Keeping the artifact API out of ``hermes_state.py`` preserves the state store's
narrow waist while the feature grows at the desktop/plugin edge.
"""

from __future__ import annotations

import json
import time
from typing import Any, Dict, List


class ArtifactRevisionConflict(ValueError):
    """The caller patched an artifact revision that is no longer current."""


class ArtifactValidationError(ValueError):
    """The artifact crossed the semantic/layout ownership boundary."""


def _validate_semantic_payload(payload: Dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise ArtifactValidationError("artifact payload must be an object")
    nodes = payload.get("nodes", [])
    if not isinstance(nodes, list):
        raise ArtifactValidationError("artifact nodes must be a list")
    geometry_keys = {"x", "y", "position", "positions", "width", "height"}
    for node in nodes:
        if not isinstance(node, dict):
            raise ArtifactValidationError("artifact nodes must be objects")
        if geometry_keys.intersection(node):
            raise ArtifactValidationError(
                "semantic artifact payload cannot contain renderer geometry"
            )


def _shape_artifact(row: Any) -> Dict[str, Any]:
    shaped = dict(row)
    shaped["payload"] = json.loads(shaped.pop("payload_json"))
    shaped["view_state"] = json.loads(shaped.pop("view_state_json"))
    return shaped


_ARTIFACT_SELECT = """SELECT session_id, artifact_id, kind, semantic_rev, view_rev,
                              payload_json, view_state_json, updated_by, created_at,
                              updated_at
                       FROM session_artifacts"""


class SessionArtifactMixin:
    """Persist and read structured artifacts owned by a conversation session."""

    def get_session_artifact(
        self, session_id: str, artifact_id: str
    ) -> Dict[str, Any] | None:
        with self._read_ctx() as conn:
            row = conn.execute(
                _ARTIFACT_SELECT
                + " WHERE session_id = ? AND artifact_id = ?",
                (session_id, artifact_id),
            ).fetchone()
        return _shape_artifact(row) if row is not None else None

    def list_session_artifacts(self, session_id: str) -> List[Dict[str, Any]]:
        with self._read_ctx() as conn:
            rows = conn.execute(
                _ARTIFACT_SELECT
                + " WHERE session_id = ? ORDER BY artifact_id",
                (session_id,),
            ).fetchall()

        return [_shape_artifact(row) for row in rows]

    def create_session_artifact(
        self,
        session_id: str,
        artifact_id: str,
        *,
        kind: str,
        payload: Dict[str, Any],
        view_state: Dict[str, Any],
        updated_by: str,
    ) -> Dict[str, Any]:
        _validate_semantic_payload(payload)
        now = time.time()
        payload_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        view_state_json = json.dumps(view_state, ensure_ascii=False, sort_keys=True)

        def _write(conn):
            conn.execute(
                """INSERT INTO session_artifacts (
                       session_id, artifact_id, kind, semantic_rev, view_rev,
                       payload_json, view_state_json, updated_by, created_at,
                       updated_at
                   ) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?)""",
                (
                    session_id,
                    artifact_id,
                    kind,
                    payload_json,
                    view_state_json,
                    updated_by,
                    now,
                    now,
                ),
            )
            return conn.execute(
                """SELECT session_id, artifact_id, kind, semantic_rev, view_rev,
                          payload_json, view_state_json, updated_by, created_at,
                          updated_at
                   FROM session_artifacts
                   WHERE session_id = ? AND artifact_id = ?""",
                (session_id, artifact_id),
            ).fetchone()

        return _shape_artifact(self._execute_write(_write))

    def update_artifact_semantics(
        self,
        session_id: str,
        artifact_id: str,
        *,
        payload: Dict[str, Any],
        expected_rev: int,
        updated_by: str,
    ) -> Dict[str, Any]:
        _validate_semantic_payload(payload)
        now = time.time()
        payload_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)

        def _write(conn):
            cursor = conn.execute(
                """UPDATE session_artifacts
                   SET payload_json = ?, semantic_rev = semantic_rev + 1,
                       updated_by = ?, updated_at = ?
                   WHERE session_id = ? AND artifact_id = ? AND semantic_rev = ?""",
                (
                    payload_json,
                    updated_by,
                    now,
                    session_id,
                    artifact_id,
                    expected_rev,
                ),
            )
            if cursor.rowcount != 1:
                raise ArtifactRevisionConflict(
                    f"semantic revision conflict for {session_id}/{artifact_id}: "
                    f"expected {expected_rev}"
                )
            return conn.execute(
                """SELECT session_id, artifact_id, kind, semantic_rev, view_rev,
                          payload_json, view_state_json, updated_by, created_at,
                          updated_at
                   FROM session_artifacts
                   WHERE session_id = ? AND artifact_id = ?""",
                (session_id, artifact_id),
            ).fetchone()

        return _shape_artifact(self._execute_write(_write))

    def update_artifact_view_state(
        self,
        session_id: str,
        artifact_id: str,
        *,
        view_state: Dict[str, Any],
        expected_rev: int,
        updated_by: str,
    ) -> Dict[str, Any]:
        now = time.time()
        view_state_json = json.dumps(view_state, ensure_ascii=False, sort_keys=True)

        def _write(conn):
            cursor = conn.execute(
                """UPDATE session_artifacts
                   SET view_state_json = ?, view_rev = view_rev + 1,
                       updated_by = ?, updated_at = ?
                   WHERE session_id = ? AND artifact_id = ? AND view_rev = ?""",
                (
                    view_state_json,
                    updated_by,
                    now,
                    session_id,
                    artifact_id,
                    expected_rev,
                ),
            )
            if cursor.rowcount != 1:
                raise ArtifactRevisionConflict(
                    f"view revision conflict for {session_id}/{artifact_id}: "
                    f"expected {expected_rev}"
                )
            return conn.execute(
                """SELECT session_id, artifact_id, kind, semantic_rev, view_rev,
                          payload_json, view_state_json, updated_by, created_at,
                          updated_at
                   FROM session_artifacts
                   WHERE session_id = ? AND artifact_id = ?""",
                (session_id, artifact_id),
            ).fetchone()

        return _shape_artifact(self._execute_write(_write))
