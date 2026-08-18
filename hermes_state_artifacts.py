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


MAX_ARTIFACT_JSON_BYTES = 64 * 1024
MAX_GRAPH_NODES = 12
MAX_GRAPH_EDGES = 24
MAX_GRAPH_ID_CHARS = 128
MAX_GRAPH_LABEL_CHARS = 200


def _required_graph_text(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str):
        raise ArtifactValidationError(f"artifact {field} must be a string")
    text = value.strip()
    if not text:
        raise ArtifactValidationError(f"artifact {field} is required")
    if len(text) > limit:
        raise ArtifactValidationError(f"artifact {field} exceeds {limit} characters")
    return text


def validate_semantic_payload(payload: Dict[str, Any]) -> None:
    if not isinstance(payload, dict):
        raise ArtifactValidationError("artifact payload must be an object")
    try:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ArtifactValidationError("artifact payload must be JSON serializable") from exc
    if len(encoded) > MAX_ARTIFACT_JSON_BYTES:
        raise ArtifactValidationError(
            f"artifact payload exceeds {MAX_ARTIFACT_JSON_BYTES} bytes"
        )

    if "nodes" not in payload and "edges" not in payload:
        return
    nodes = payload.get("nodes")
    edges = payload.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ArtifactValidationError("artifact graph requires nodes and edges lists")
    if len(nodes) > MAX_GRAPH_NODES:
        raise ArtifactValidationError(f"artifact graph may contain at most {MAX_GRAPH_NODES} nodes")
    if len(edges) > MAX_GRAPH_EDGES:
        raise ArtifactValidationError(f"artifact graph may contain at most {MAX_GRAPH_EDGES} edges")

    geometry_keys = {"x", "y", "position", "positions", "width", "height"}
    node_ids: set[str] = set()
    for node in nodes:
        if not isinstance(node, dict):
            raise ArtifactValidationError("artifact nodes must be objects")
        if geometry_keys.intersection(node):
            raise ArtifactValidationError(
                "semantic artifact payload cannot contain renderer geometry"
            )
        node_id = _required_graph_text(node.get("id"), "node id", MAX_GRAPH_ID_CHARS)
        _required_graph_text(node.get("label"), "node label", MAX_GRAPH_LABEL_CHARS)
        kind = node.get("kind")
        if kind is not None and kind != "":
            _required_graph_text(kind, "node kind", 64)
        if node_id in node_ids:
            raise ArtifactValidationError(f"artifact graph has duplicate node id: {node_id}")
        node_ids.add(node_id)

    edge_ids: set[str] = set()
    for edge in edges:
        if not isinstance(edge, dict):
            raise ArtifactValidationError("artifact edges must be objects")
        edge_id = _required_graph_text(edge.get("id"), "edge id", MAX_GRAPH_ID_CHARS)
        source = _required_graph_text(edge.get("from"), "edge from", MAX_GRAPH_ID_CHARS)
        target = _required_graph_text(edge.get("to"), "edge to", MAX_GRAPH_ID_CHARS)
        if edge_id in edge_ids:
            raise ArtifactValidationError(f"artifact graph has duplicate edge id: {edge_id}")
        if source not in node_ids or target not in node_ids:
            raise ArtifactValidationError(f"artifact edge {edge_id} references an unknown node")
        label = edge.get("label")
        if label is not None and label != "":
            _required_graph_text(label, "edge label", MAX_GRAPH_LABEL_CHARS)
        edge_ids.add(edge_id)


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
        validate_semantic_payload(payload)
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
        validate_semantic_payload(payload)
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
