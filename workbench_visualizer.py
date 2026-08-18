"""Mute ambient diagrammer invoked explicitly by the Realtime voice agent."""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, Tuple

from hermes_state_artifacts import (
    MAX_GRAPH_EDGES,
    MAX_GRAPH_NODES,
    MAX_QUADRANT_ITEMS,
    MAX_TIMELINE_ITEMS,
    trim_payload_for_kind,
    validate_semantic_payload,
)


_MAX_TRANSCRIPT_CHARS = 64_000
_MAX_DIRECTION_CHARS = 1_000

# The kind is the diagrammer's own choice. `map` stays the default so an older
# model, a malformed reply, or an unrecognised name never regresses behaviour.
DEFAULT_KIND = "map"
SUPPORTED_KINDS = ("map", "timeline", "quadrant")

_VISUALIZER_INSTRUCTIONS = f"""You are the mute diagrammer for a live voice ideation workbench.
Choose the ONE visual form that actually fits what the conversation needs right now, then return ONLY JSON.

"map" — relationships, systems, dependencies, how parts connect:
{{"kind":"map","nodes":[{{"id":"stable-id","label":"short label","kind":"optional"}}],"edges":[{{"id":"stable-id","from":"node-id","to":"node-id","label":"optional"}}]}}

"timeline" — sequences, phases, roadmaps, steps in order, before/after:
{{"kind":"timeline","items":[{{"id":"stable-id","label":"short label","detail":"optional one line","order":0}}]}}

"quadrant" — trade-offs and comparisons along two named axes:
{{"kind":"quadrant","axes":{{"x":{{"low":"...","high":"..."}},"y":{{"low":"...","high":"..."}}}},"items":[{{"id":"stable-id","label":"short label","x":0.5,"y":0.5}}]}}

Pick the form by what the ideas ARE, not by habit: a sequence is a timeline, a trade-off is a quadrant, a structure is a map.
Keep the current kind unless the conversation has genuinely moved to a different shape; switching redraws everything.
Read the transcript as a whole and update the current artifact rather than redrawing from scratch.
Preserve existing ids for the same concept. Draw only what materially helps the shared idea.
Prefer a legible diagram over an exhaustive one.
Quadrant x/y are meaning, not pixels: numbers from 0 to 1 saying where the idea sits between the low and high labels.
Never emit prose, Markdown, pixel coordinates, more than {MAX_GRAPH_NODES} nodes, more than {MAX_GRAPH_EDGES} edges, more than {MAX_TIMELINE_ITEMS} timeline items, or more than {MAX_QUADRANT_ITEMS} quadrant items."""


def _empty_payload(kind: str) -> Dict[str, Any]:
    if kind == "timeline":
        return {"items": []}
    if kind == "quadrant":
        return {"axes": {}, "items": []}
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


def _parse_payload(text: str) -> Tuple[str, Dict[str, Any]]:
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
    if kind is None:
        kind = _infer_kind(parsed)

    # Bound the payload to what the canvas can show BEFORE validating, so an
    # over-eager diagram degrades to its core instead of failing the update
    # and surfacing to the user as a broken workbench.
    payload = trim_payload_for_kind(kind, parsed)
    validate_semantic_payload(payload, kind)
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
    request = {
        "direction": str(prompt or "").strip()[:_MAX_DIRECTION_CHARS],
        "current_kind": current_kind,
        "current_graph": current["payload"] if current else _empty_payload(DEFAULT_KIND),
        "transcript": _bounded_transcript(messages),
    }

    if run_oneshot_fn is None:
        from agent.oneshot import run_oneshot

        run_oneshot_fn = run_oneshot

    generated = run_oneshot_fn(
        instructions=_VISUALIZER_INSTRUCTIONS,
        user_input=json.dumps(request, ensure_ascii=False),
        task="ideation_workbench",
        max_tokens=800,
        temperature=0.2,
        timeout=45,
        main_runtime=None,
    )
    kind, payload = _parse_payload(generated)

    if current:
        return db.update_artifact_semantics(
            session_id,
            current["artifact_id"],
            payload=payload,
            expected_rev=current["semantic_rev"],
            updated_by="ambient",
            kind=kind,
        )

    return db.create_session_artifact(
        session_id,
        "map.main",
        kind=kind,
        payload=payload,
        view_state={"positions": {}, "pinned": []},
        updated_by="ambient",
    )
