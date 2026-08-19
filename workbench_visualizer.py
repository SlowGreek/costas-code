"""Mute ambient diagrammer invoked explicitly by the Realtime voice agent."""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, Tuple

from hermes_state_artifacts import (
    MAX_GRAPH_EDGES,
    MAX_GRAPH_NODES,
    MAX_QUADRANT_ITEMS,
    MAX_TIMELINE_ITEMS,
    apply_graph_ops,
    summarize_trim,
    trim_payload_for_kind,
    validate_semantic_payload,
)
from workbench_sketch import SKETCH_MODEL_GUIDANCE, validate_sketch_payload


_MAX_TRANSCRIPT_CHARS = 64_000
_MAX_DIRECTION_CHARS = 1_000

# One ceiling for every visualizer turn. `max_tokens` is a CAP, not a
# reservation: a map costs a few hundred tokens either way, while a sketch is a
# whole HTML document. The old 800-token default keyed off `direction`, which is
# empty on the now-proactive first draw — so the truncation cliff sat exactly on
# the happy path.
MAX_VISUALIZER_OUTPUT_TOKENS = 6_000

# The kind is the diagrammer's own choice. `map` stays the default so an older
# model, a malformed reply, or an unrecognised name never regresses behaviour.
DEFAULT_KIND = "map"
SUPPORTED_KINDS = ("map", "timeline", "quadrant", "sketch")

_VISUALIZER_INSTRUCTIONS = f"""You are the mute diagrammer for a live voice ideation workbench.
Choose the ONE visual form that actually fits what the conversation needs right now, then return ONLY JSON.

"map" — relationships, systems, dependencies, how parts connect:
{{"kind":"map","nodes":[{{"id":"stable-id","label":"short label","kind":"agent"}}],"edges":[{{"id":"stable-id","from":"node-id","to":"node-id","label":"optional"}}]}}
A node's `kind` is optional but it colours the node, so use it. It must be exactly one of:
actor, agent, concept, constraint, decision, goal, idea, insight, question, risk, surface, system, task.
Any other value falls back to a generic accent — do NOT invent kinds like "component" or "infra".

"timeline" — sequences, phases, roadmaps, steps in order, before/after:
{{"kind":"timeline","items":[{{"id":"stable-id","label":"short label","detail":"optional one line","order":0}}]}}

"quadrant" — trade-offs and comparisons along two named axes:
{{"kind":"quadrant","axes":{{"x":{{"low":"...","high":"..."}},"y":{{"low":"...","high":"..."}}}},"items":[{{"id":"stable-id","label":"short label","x":0.5,"y":0.5}}]}}

"sketch" — self-contained HTML/CSS/JS (canvas, WebGL, SVG, animation) rendered in a locked-down sandbox:
{{"kind":"sketch","html":"<canvas id=\\"c\\"></canvas><style>...</style><script>...</script>"}}
The runtime provides its own full-bleed canvas via `Sketch.canvas()` (id `sketch-canvas`) — you do not need to author a <canvas> element yourself; the id in the example above is illustrative only.
Reach for it when the idea is visual, spatial, dynamic, or illustrative rather than structural — a rendered 3D object, a simulation, a chart, a custom visual metaphor, an animated concept.
Trade-off to weigh honestly: a sketch is redrawn whole and has no stable ids, so the user cannot point at its parts the way they can with a map. Worth it when the picture itself is the point.
Full sketch capabilities, the `Sketch` runtime API, and the hard size limit are in the SKETCH RUNTIME section at the end of these instructions.

You are given JSON with four keys:
`transcript` — the conversation so far. Read it as a whole.
`current_kind` and `current_graph` — your own previous work (nodes/edges, items, or html). REVISE it rather than redrawing from scratch, and preserve existing ids for the same concept. For a sketch that means editing the HTML you produced last time, unless the idea itself changed.
`direction` — an optional instruction from the voice agent about what to change right now. When it is non-empty it is the highest-priority input: it is what the user just asked for, and your output should visibly satisfy it.

PREFER AN INCREMENTAL DIFF. When a `map` is already on screen and the change is describable as a few edits, return ops INSTEAD of a whole payload:
{{"ops":[{{"op":"add_node","id":"stable-id","label":"short label","kind":"agent"}},{{"op":"connect","from_id":"a","to_id":"b","label":"optional"}},{{"op":"rename","node_id":"a","label":"New label"}},{{"op":"disconnect","edge_id":"e1"}},{{"op":"remove","node_id":"a"}}]}}
Ops apply in order, so you can add a node and connect to it in the same diff. The whole diff is rejected if any single op fails, so only reference ids that exist in `current_graph` (or that an earlier op in the same diff created).
This is dramatically faster than redrawing — a few ops instead of every node and edge — and the user is waiting. Use it for anything short of a wholesale rethink.
Return a FULL payload only when there is no current graph, when you are changing kind, or when so much changes that a diff would be longer than the drawing.
Positions, spacing and arrangement are the renderer's job — never attach coordinates to map or timeline payloads, and never try to lay the diagram out. (Quadrant x/y are the exception: they are semantic 0..1 values saying where the idea sits between the low and high labels, not pixels. Sketch HTML uses its own drawing coordinates, which is fine.)
If `direction` is about appearance rather than content ("make it prettier", "tidy it up", "less cluttered"), the fix you CAN make is editorial: shorten verbose labels, drop exact-duplicate or redundant edges, cut items that carry no distinct idea. Do not invent structure, and do not delete a distinct concept just to look tidier.

All four forms are equally available — pick by what the ideas ARE, not by habit: a sequence is a timeline, a trade-off is a quadrant, a structure is a map, something you need to actually SEE is a sketch.
Switch kind as often as the ideas warrant. If a sequence becomes a trade-off, or a structure becomes something you need to SEE, change form immediately — never keep an ill-fitting shape just because it is what you drew last time.
Draw only what materially helps the shared idea.
Prefer a legible diagram over an exhaustive one.
In map / timeline / quadrant payloads: never emit prose or Markdown, never attach renderer coordinates, and never exceed {MAX_GRAPH_NODES} nodes, {MAX_GRAPH_EDGES} edges, {MAX_TIMELINE_ITEMS} timeline items, or {MAX_QUADRANT_ITEMS} quadrant items. Return ONLY the JSON object.

SKETCH RUNTIME — only relevant if you chose "sketch"; ignore it entirely for map, timeline, and quadrant.
Read the following as advice about the document you put in the outer JSON object's `html` string. It never overrides the protocol above: still return ONLY the JSON object, never a raw HTML document.
Practical size: 128 KiB is the hard validation cap, but your generation budget is tighter, and HTML cut off mid-tag is ACCEPTED rather than rejected — a silently broken sketch. Keep it well under ~15 KB.
""" + SKETCH_MODEL_GUIDANCE


def _empty_payload(kind: str) -> Dict[str, Any]:
    if kind == "timeline":
        return {"items": []}
    if kind == "quadrant":
        return {"axes": {}, "items": []}
    if kind == "sketch":
        return {"html": ""}
    return {"nodes": [], "edges": []}


def _bounded_transcript(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    selected: list[dict[str, str]] = []
    chars = 0
    for message in reversed(messages):
        role = str(message.get("role") or "")
        content = message.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            continue
        text = content.strip()
        if not text:
            continue
        remaining = _MAX_TRANSCRIPT_CHARS - chars
        if remaining <= 0:
            break
        if len(text) > remaining:
            text = text[-remaining:]
        selected.append({"role": role, "text": text})
        chars += len(text)
    selected.reverse()
    return selected


def _infer_kind(payload: Dict[str, Any]) -> str:
    """Fall back to shape when the model forgot or mangled the `kind` field."""
    if "axes" in payload and "items" in payload:
        return "quadrant"
    if "items" in payload and "nodes" not in payload:
        return "timeline"
    return DEFAULT_KIND


def _parse_payload_with_trim(
    text: str, current_payload: Dict[str, Any] | None = None
) -> Tuple[str, Dict[str, Any], Dict[str, int] | None, bool]:
    """Parse the diagrammer reply.

    Returns kind, payload, trim disclosure, and whether the INCREMENTAL path
    was taken. That last flag is instrumentation, not decoration: without it
    there is no way to tell from stored data whether the model actually used
    the fast path, and "it still feels slow" becomes unfalsifiable.

    Accepts either a whole payload or an incremental `ops` diff. The diff path
    is the fast one: emitting three ops instead of forty nodes is the
    difference between a redraw the user waits through and one they don't.
    """
    stripped = str(text or "").strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if len(lines) >= 2 and lines[-1].strip() == "```":
            stripped = "\n".join(lines[1:-1]).strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        raise ValueError("workbench visualizer returned no JSON object")
    try:
        parsed = json.loads(stripped[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError("workbench visualizer returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("workbench visualizer returned a non-object payload")

    declared = parsed.pop("kind", None)
    kind = declared if isinstance(declared, str) and declared in SUPPORTED_KINDS else None

    # An `ops` diff patches what is already on screen. Only valid against an
    # existing graph: there is nothing to diff against on a first draw (an
    # empty node list is a placeholder, not a drawing), and a timeline has no
    # nodes to patch.
    if isinstance(parsed.get("ops"), list):
        if (
            not isinstance(current_payload, dict)
            or not isinstance(current_payload.get("nodes"), list)
            or not current_payload["nodes"]
        ):
            raise ValueError("workbench visualizer returned ops with no graph to apply them to")

        patched = apply_graph_ops(current_payload, parsed["ops"])
        payload = trim_payload_for_kind("map", patched)
        validate_semantic_payload(payload, "map")
        return "map", payload, summarize_trim("map", patched, payload), True

    if kind is None:
        kind = _infer_kind(parsed)

    # A sketch is arbitrary model-authored HTML, not a semantic graph: it has
    # its own validator and its own (sandboxed) renderer, and it is atomic —
    # trimming HTML at a byte offset would yield a broken document.
    if kind == "sketch":
        return kind, validate_sketch_payload(parsed), None, False

    # Bound the payload to what the canvas can show BEFORE validating, so an
    # over-eager diagram degrades to its core instead of failing the update
    # and surfacing to the user as a broken workbench.
    payload = trim_payload_for_kind(kind, parsed)
    validate_semantic_payload(payload, kind)
    return kind, payload, summarize_trim(kind, parsed, payload), False


def _parse_payload(text: str) -> Tuple[str, Dict[str, Any]]:
    kind, payload, _, _ = _parse_payload_with_trim(text)
    return kind, payload


# Back-compat alias: callers/tests that only cared about the graph shape.
def _parse_graph(text: str) -> Dict[str, Any]:
    return _parse_payload(text)[1]


def visualize_session(
    db,
    session_id: str,
    *,
    prompt: str = "",
    run_oneshot_fn: Callable[..., str] | None = None,
) -> Dict[str, Any]:
    """Delegate one voice-decided visual update and persist its semantic payload."""
    current = db.get_session_artifact(session_id, "map.main")
    messages = db.get_messages_as_conversation(
        session_id,
        include_ancestors=True,
        repair_alternation=False,
    )
    current_kind = str(current["kind"]) if current else DEFAULT_KIND
    current_payload = current["payload"] if current else _empty_payload(DEFAULT_KIND)
    request = {
        "direction": str(prompt or "").strip()[:_MAX_DIRECTION_CHARS],
        "current_kind": current_kind,
        # Named `current_graph` for backward compatibility with the original
        # graph-only contract; it now carries whatever the current kind's
        # payload is (nodes/edges, items, or html) so the model can revise its
        # own previous work rather than redrawing blind.
        "current_graph": current_payload,
        "transcript": _bounded_transcript(messages),
    }

    if run_oneshot_fn is None:
        from agent.oneshot import run_oneshot

        run_oneshot_fn = run_oneshot

    # One generous ceiling for every turn — see MAX_VISUALIZER_OUTPUT_TOKENS.
    generated = run_oneshot_fn(
        instructions=_VISUALIZER_INSTRUCTIONS,
        user_input=json.dumps(request, ensure_ascii=False),
        task="ideation_workbench",
        max_tokens=MAX_VISUALIZER_OUTPUT_TOKENS,
        temperature=0.2,
        timeout=45,
        main_runtime=None,
    )
    kind, payload, trimmed, incremental = _parse_payload_with_trim(generated, current_payload)

    if current:
        artifact = db.update_artifact_semantics(
            session_id,
            current["artifact_id"],
            payload=payload,
            expected_rev=current["semantic_rev"],
            # Distinguish the fast path in stored data. Without this there is
            # no way to answer "did the model actually emit a diff?" after the
            # fact, and a redraw that silently stayed slow looks identical to
            # one that got faster.
            updated_by="ambient-diff" if incremental else "ambient",
            kind=kind,
        )
        return _record_trim(db, session_id, artifact, trimmed)

    view_state: Dict[str, Any] = {"positions": {}, "pinned": []}
    if trimmed:
        view_state["trimmed"] = trimmed
    return db.create_session_artifact(
        session_id,
        "map.main",
        kind=kind,
        payload=payload,
        view_state=view_state,
        updated_by="ambient",
    )


def _record_trim(
    db, session_id: str, artifact: Dict[str, Any], trimmed: Dict[str, int] | None
) -> Dict[str, Any]:
    """Keep the trim disclosure in ``view_state`` in sync with this revision.

    ``view_state`` (not the semantic payload) is the right home: "showing 40 of
    57" is a statement about what the canvas can display, and the semantic
    payload must not carry renderer concerns. It also survives the round trip
    to the renderer because the artifact row is persisted whole.
    """
    view_state = artifact.get("view_state")
    if not isinstance(view_state, dict):
        view_state = {}
    if view_state.get("trimmed") == trimmed or (not trimmed and "trimmed" not in view_state):
        return artifact

    next_state = dict(view_state)
    if trimmed:
        next_state["trimmed"] = trimmed
    else:
        next_state.pop("trimmed", None)

    try:
        return db.update_artifact_view_state(
            session_id,
            artifact["artifact_id"],
            view_state=next_state,
            expected_rev=artifact["view_rev"],
            updated_by="ambient",
        )
    except Exception:
        # Disclosure is best-effort: never fail a successful drawing over it.
        return artifact
