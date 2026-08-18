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
# Canvas legibility bound, not a safety bound. Real ideation sessions outgrow a
# dozen concepts quickly, so this is generous enough to hold a whole system
# sketch; the visualizer trims to it rather than failing the update.
MAX_GRAPH_NODES = 40
MAX_GRAPH_EDGES = 80
MAX_GRAPH_ID_CHARS = 128
MAX_GRAPH_LABEL_CHARS = 200

# Timeline/quadrant legibility bounds. Same principle as the graph caps: the
# visualizer trims to them rather than failing the update.
MAX_TIMELINE_ITEMS = 24
MAX_QUADRANT_ITEMS = 32
MAX_DETAIL_CHARS = 400
MAX_AXIS_LABEL_CHARS = 80

# Kinds whose payload this module knows how to validate. Anything else falls
# back to the historical `map` behaviour so unknown kinds never hard-fail.
KNOWN_ARTIFACT_KINDS = ("map", "timeline", "quadrant")

GEOMETRY_KEYS = frozenset({"x", "y", "position", "positions", "width", "height"})


def _required_graph_text(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str):
        raise ArtifactValidationError(f"artifact {field} must be a string")
    text = value.strip()
    if not text:
        raise ArtifactValidationError(f"artifact {field} is required")
    if len(text) > limit:
        raise ArtifactValidationError(f"artifact {field} exceeds {limit} characters")
    return text


def _trim_graph(graph: Dict[str, Any]) -> Dict[str, Any]:
    """Bound a graph to the canvas limits, keeping its most connected core.

    The diagrammer regularly proposes more than the canvas should show. Failing
    the write would surface mid-conversation as "couldn't update the workbench",
    so degrade instead: drop the least-connected nodes (they carry the least
    structure), then drop any edge left dangling.
    """
    nodes = graph.get("nodes")
    edges = graph.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        return graph
    if len(nodes) <= MAX_GRAPH_NODES and len(edges) <= MAX_GRAPH_EDGES:
        return graph

    degree: Dict[str, int] = {}
    for node in nodes:
        if isinstance(node, dict) and isinstance(node.get("id"), str):
            degree.setdefault(node["id"], 0)
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        for side in ("from", "to"):
            node_id = edge.get(side)
            if isinstance(node_id, str) and node_id in degree:
                degree[node_id] += 1

    # Most connected first; ties keep the model's own ordering, which puts the
    # concepts it considered most important earliest.
    order = {
        node["id"]: index
        for index, node in enumerate(nodes)
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    ranked = sorted(order, key=lambda nid: (-degree.get(nid, 0), order[nid]))
    kept_ids = set(ranked[:MAX_GRAPH_NODES])

    kept_nodes = [
        node for node in nodes
        if isinstance(node, dict) and node.get("id") in kept_ids
    ]
    kept_edges = [
        edge for edge in edges
        if isinstance(edge, dict)
        and edge.get("from") in kept_ids
        and edge.get("to") in kept_ids
    ][:MAX_GRAPH_EDGES]

    trimmed = dict(graph)
    trimmed["nodes"] = kept_nodes
    trimmed["edges"] = kept_edges
    return trimmed


def _trim_timeline(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Bound a timeline to what the canvas can show, keeping the earliest steps.

    Same degrade-don't-fail contract as ``_trim_graph``: a too-long story loses
    its tail rather than surfacing as a broken workbench mid-conversation.
    """
    items = payload.get("items")
    if not isinstance(items, list) or len(items) <= MAX_TIMELINE_ITEMS:
        return payload

    def sort_key(pair):
        index, item = pair
        order = item.get("order") if isinstance(item, dict) else None
        return (order if isinstance(order, int) and not isinstance(order, bool) else index, index)

    ranked = sorted(enumerate(items), key=sort_key)[:MAX_TIMELINE_ITEMS]
    trimmed = dict(payload)
    trimmed["items"] = [item for _, item in sorted(ranked, key=lambda pair: pair[0])]
    return trimmed


def _trim_quadrant(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Bound a quadrant plot, keeping the model's earliest (most salient) items."""
    items = payload.get("items")
    if not isinstance(items, list) or len(items) <= MAX_QUADRANT_ITEMS:
        return payload
    trimmed = dict(payload)
    trimmed["items"] = items[:MAX_QUADRANT_ITEMS]
    return trimmed


def trim_payload_for_kind(kind: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Degrade an over-cap payload to canvas limits for the given kind."""
    if not isinstance(payload, dict):
        return payload
    if kind == "timeline":
        return _trim_timeline(payload)
    if kind == "quadrant":
        return _trim_quadrant(payload)
    return _trim_graph(payload)


def _count_for_kind(kind: str, payload: Any) -> int | None:
    """How many primary items a payload carries, or None if it has no notion."""
    if not isinstance(payload, dict):
        return None
    if kind in ("timeline", "quadrant"):
        items = payload.get("items")
        return len(items) if isinstance(items, list) else None
    nodes = payload.get("nodes")
    return len(nodes) if isinstance(nodes, list) else None


def summarize_trim(
    kind: str, proposed: Any, trimmed: Any
) -> Dict[str, int] | None:
    """Describe what ``trim_payload_for_kind`` dropped, for honest disclosure.

    Returns ``{"shown": kept, "total": proposed}`` when items were dropped, and
    ``None`` when the payload fit. The caller stores this alongside the
    artifact (in ``view_state``) rather than inside the semantic payload: the
    count is a statement about what the CANVAS can show, i.e. a renderer
    concern, and the semantic payload must stay free of renderer concerns.
    """
    total = _count_for_kind(kind, proposed)
    shown = _count_for_kind(kind, trimmed)
    if total is None or shown is None or shown >= total:
        return None
    return {"shown": shown, "total": total}


def _semantic_unit(value: Any, field: str) -> float:
    """Validate a quadrant coordinate: a real number in 0..1.

    Quadrant items are the ONE payload-carried coordinate exemption; the value
    is the model's judgement of where an idea sits, not a pixel.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ArtifactValidationError(f"artifact {field} must be a number")
    if not 0.0 <= float(value) <= 1.0:
        raise ArtifactValidationError(f"artifact {field} must be between 0 and 1")
    return float(value)


def _validate_timeline(payload: Dict[str, Any]) -> None:
    items = payload.get("items")
    if not isinstance(items, list):
        raise ArtifactValidationError("artifact timeline requires an items list")
    if len(items) > MAX_TIMELINE_ITEMS:
        raise ArtifactValidationError(
            f"artifact timeline may contain at most {MAX_TIMELINE_ITEMS} items"
        )

    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise ArtifactValidationError("artifact timeline items must be objects")
        if GEOMETRY_KEYS.intersection(item):
            raise ArtifactValidationError(
                "semantic artifact payload cannot contain renderer geometry"
            )
        item_id = _required_graph_text(item.get("id"), "timeline item id", MAX_GRAPH_ID_CHARS)
        _required_graph_text(item.get("label"), "timeline item label", MAX_GRAPH_LABEL_CHARS)
        detail = item.get("detail")
        if detail is not None and detail != "":
            _required_graph_text(detail, "timeline item detail", MAX_DETAIL_CHARS)
        order = item.get("order")
        if order is not None:
            if isinstance(order, bool) or not isinstance(order, int):
                raise ArtifactValidationError("artifact timeline item order must be an integer")
        if item_id in seen:
            raise ArtifactValidationError(
                f"artifact timeline has duplicate item id: {item_id}"
            )
        seen.add(item_id)


def _validate_quadrant(payload: Dict[str, Any]) -> None:
    axes = payload.get("axes")
    if not isinstance(axes, dict):
        raise ArtifactValidationError("artifact quadrant requires an axes object")
    for axis_name in ("x", "y"):
        axis = axes.get(axis_name)
        if not isinstance(axis, dict):
            raise ArtifactValidationError(f"artifact quadrant axes.{axis_name} must be an object")
        for end in ("low", "high"):
            _required_graph_text(
                axis.get(end), f"quadrant axes.{axis_name}.{end}", MAX_AXIS_LABEL_CHARS
            )

    items = payload.get("items")
    if not isinstance(items, list):
        raise ArtifactValidationError("artifact quadrant requires an items list")
    if len(items) > MAX_QUADRANT_ITEMS:
        raise ArtifactValidationError(
            f"artifact quadrant may contain at most {MAX_QUADRANT_ITEMS} items"
        )

    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise ArtifactValidationError("artifact quadrant items must be objects")
        forbidden = (GEOMETRY_KEYS - {"x", "y"}).intersection(item)
        if forbidden:
            raise ArtifactValidationError(
                "semantic artifact payload cannot contain renderer geometry"
            )
        item_id = _required_graph_text(item.get("id"), "quadrant item id", MAX_GRAPH_ID_CHARS)
        _required_graph_text(item.get("label"), "quadrant item label", MAX_GRAPH_LABEL_CHARS)
        _semantic_unit(item.get("x"), f"quadrant item {item_id} x")
        _semantic_unit(item.get("y"), f"quadrant item {item_id} y")
        if item_id in seen:
            raise ArtifactValidationError(
                f"artifact quadrant has duplicate item id: {item_id}"
            )
        seen.add(item_id)


def validate_semantic_payload(payload: Dict[str, Any], kind: str = "map") -> None:
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

    if kind == "timeline":
        _validate_timeline(payload)
        return
    if kind == "quadrant":
        _validate_quadrant(payload)
        return

    # `map` (and any unrecognised kind) keeps the historical graph behaviour.
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
        node_kind = node.get("kind")
        if node_kind is not None and node_kind != "":
            _required_graph_text(node_kind, "node kind", 64)
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


# --- surgical edits -------------------------------------------------------
#
# A surgical edit changes exactly ONE thing in an existing graph without
# invoking the diagrammer model. It reuses `validate_semantic_payload`
# verbatim, so every existing invariant (no geometry in the payload, id
# stability, caps, referential integrity) still holds, and the caller still
# goes through `update_artifact_semantics`, so revision-conflict handling is
# unchanged. The trim policy is deliberately NOT applied: a surgical edit can
# only shrink the graph or add one edge, so it can never exceed a cap that the
# stored payload already respected.

SURGICAL_EDIT_OPS = ("rename", "connect", "disconnect", "remove")


class SurgicalEditError(ValueError):
    """A surgical edit could not be applied to the stored graph."""


def _edit_text(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SurgicalEditError(f"{field} is required")
    text = value.strip()
    if len(text) > limit:
        raise SurgicalEditError(f"{field} exceeds {limit} characters")
    return text


def _next_edge_id(from_id: str, to_id: str, taken: set[str]) -> str:
    base = f"e-{from_id}-{to_id}"
    if base not in taken:
        return base
    index = 2
    while f"{base}-{index}" in taken:
        index += 1
    return f"{base}-{index}"


def apply_surgical_edit(payload: Dict[str, Any], edit: Dict[str, Any]) -> Dict[str, Any]:
    """Return a NEW graph payload with one surgical edit applied.

    Raises ``SurgicalEditError`` when the edit does not apply (unknown node or
    edge, self-edge, empty label). Never mutates the input.
    """
    if not isinstance(payload, dict):
        raise SurgicalEditError("artifact payload must be an object")
    nodes = payload.get("nodes")
    edges = payload.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise SurgicalEditError("surgical edits require a graph artifact")
    if not isinstance(edit, dict):
        raise SurgicalEditError("edit must be an object")

    op = str(edit.get("op") or "").strip()
    if op not in SURGICAL_EDIT_OPS:
        raise SurgicalEditError(f"unsupported surgical edit op: {op or '<missing>'}")

    node_ids = {n.get("id") for n in nodes if isinstance(n, dict)}
    result = dict(payload)

    if op == "rename":
        node_id = _edit_text(edit.get("node_id"), "node_id", MAX_GRAPH_ID_CHARS)
        label = _edit_text(edit.get("label"), "label", MAX_GRAPH_LABEL_CHARS)
        if node_id not in node_ids:
            raise SurgicalEditError(f"unknown node: {node_id}")
        # Node ids are stable; a rename touches the label only.
        result["nodes"] = [
            {**n, "label": label} if isinstance(n, dict) and n.get("id") == node_id else n
            for n in nodes
        ]
        return result

    if op == "remove":
        node_id = _edit_text(edit.get("node_id"), "node_id", MAX_GRAPH_ID_CHARS)
        if node_id not in node_ids:
            raise SurgicalEditError(f"unknown node: {node_id}")
        result["nodes"] = [
            n for n in nodes if not (isinstance(n, dict) and n.get("id") == node_id)
        ]
        # Edges to a removed node would dangle, which validation rejects.
        result["edges"] = [
            e
            for e in edges
            if not (isinstance(e, dict) and node_id in (e.get("from"), e.get("to")))
        ]
        return result

    if op == "disconnect":
        edge_id = _edit_text(edit.get("edge_id"), "edge_id", MAX_GRAPH_ID_CHARS)
        if not any(isinstance(e, dict) and e.get("id") == edge_id for e in edges):
            raise SurgicalEditError(f"unknown edge: {edge_id}")
        result["edges"] = [
            e for e in edges if not (isinstance(e, dict) and e.get("id") == edge_id)
        ]
        return result

    from_id = _edit_text(edit.get("from_id"), "from_id", MAX_GRAPH_ID_CHARS)
    to_id = _edit_text(edit.get("to_id"), "to_id", MAX_GRAPH_ID_CHARS)
    if from_id not in node_ids:
        raise SurgicalEditError(f"unknown node: {from_id}")
    if to_id not in node_ids:
        raise SurgicalEditError(f"unknown node: {to_id}")
    if from_id == to_id:
        raise SurgicalEditError("connect requires two different nodes")
    if len(edges) >= MAX_GRAPH_EDGES:
        raise SurgicalEditError(f"artifact graph already holds {MAX_GRAPH_EDGES} edges")

    label_raw = edit.get("label")
    edge: Dict[str, Any] = {
        "id": _next_edge_id(
            from_id,
            to_id,
            {str(e.get("id")) for e in edges if isinstance(e, dict)},
        ),
        "from": from_id,
        "to": to_id,
    }
    if isinstance(label_raw, str) and label_raw.strip():
        edge["label"] = _edit_text(label_raw, "label", MAX_GRAPH_LABEL_CHARS)
    result["edges"] = [*edges, edge]
    return result


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
        validate_semantic_payload(payload, kind)
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
        kind: str | None = None,
    ) -> Dict[str, Any]:
        if kind is None:
            existing = self.get_session_artifact(session_id, artifact_id)
            kind = str(existing["kind"]) if existing else "map"
        validate_semantic_payload(payload, kind)
        now = time.time()
        payload_json = json.dumps(payload, ensure_ascii=False, sort_keys=True)

        def _write(conn):
            cursor = conn.execute(
                """UPDATE session_artifacts
                   SET payload_json = ?, kind = ?, semantic_rev = semantic_rev + 1,
                       updated_by = ?, updated_at = ?
                   WHERE session_id = ? AND artifact_id = ? AND semantic_rev = ?""",
                (
                    payload_json,
                    kind,
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
