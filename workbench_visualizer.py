"""Mute ambient diagrammer invoked explicitly by the Realtime voice agent."""

from __future__ import annotations

import json
from typing import Any, Callable, Dict

from hermes_state_artifacts import (
    MAX_GRAPH_EDGES,
    MAX_GRAPH_NODES,
    _trim_graph,
    validate_semantic_payload,
)


_MAX_TRANSCRIPT_CHARS = 64_000
_MAX_DIRECTION_CHARS = 1_000
_VISUALIZER_INSTRUCTIONS = f"""You are the mute diagrammer for a live voice ideation workbench.
Return ONLY JSON with this exact shape:
{{"nodes":[{{"id":"stable-id","label":"short label","kind":"optional"}}],"edges":[{{"id":"stable-id","from":"node-id","to":"node-id","label":"optional"}}]}}.
Read the transcript as a whole and update the current graph rather than redrawing from scratch.
Preserve existing ids for the same concept. Draw only what materially helps the shared idea.
Prefer a legible diagram over an exhaustive one.
Never emit coordinates, prose, Markdown, more than {MAX_GRAPH_NODES} nodes, or more than {MAX_GRAPH_EDGES} edges."""


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


def _parse_graph(text: str) -> Dict[str, Any]:
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
        graph = json.loads(stripped[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError("workbench visualizer returned invalid JSON") from exc
    # Bound the graph to what the canvas can show BEFORE validating, so an
    # over-eager diagram degrades to its core instead of failing the update
    # and surfacing to the user as a broken workbench.
    graph = _trim_graph(graph)
    validate_semantic_payload(graph)
    return graph


def visualize_session(
    db,
    session_id: str,
    *,
    prompt: str = "",
    run_oneshot_fn: Callable[..., str] | None = None,
) -> Dict[str, Any]:
    """Delegate one voice-decided visual update and persist its semantic graph."""
    current = db.get_session_artifact(session_id, "map.main")
    messages = db.get_messages_as_conversation(
        session_id,
        include_ancestors=True,
        repair_alternation=False,
    )
    request = {
        "direction": str(prompt or "").strip()[:_MAX_DIRECTION_CHARS],
        "current_graph": current["payload"] if current else {"nodes": [], "edges": []},
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
    payload = _parse_graph(generated)

    if current:
        return db.update_artifact_semantics(
            session_id,
            current["artifact_id"],
            payload=payload,
            expected_rev=current["semantic_rev"],
            updated_by="ambient",
        )

    return db.create_session_artifact(
        session_id,
        "map.main",
        kind="map",
        payload=payload,
        view_state={"positions": {}, "pinned": []},
        updated_by="ambient",
    )
