"""Spawn one workflow subagent and return validated structured output.

This is the bridge between a workflow script's ``agent(prompt, schema=...)``
call and Hermes' real subagent machinery. It exists as its own module because
the workflow runtime needs something ``delegate_task`` deliberately is not:

* **synchronous and value-returning.** ``delegate_task`` at the top level forces
  ``background=(not _is_subagent)`` and ignores the schema-level ``background``
  param entirely (``run_agent.py``), returning a handle whose result re-enters
  the *conversation* later. A workflow needs the value back in a Python
  variable, now, so the script can branch on it.
* **structured.** A child returns whatever prose it ended on. Orchestration code
  needs validated JSON (see :mod:`agent.structured_output`).
* **depth-explicit.** See the safety note below.

Depth is passed explicitly and fails closed
-------------------------------------------
``_build_child_agent`` derives a child's depth with
``getattr(parent_agent, "_delegate_depth", 0) + 1``. That default of ``0`` is
correct for a real ``AIAgent`` parent, but it fails *open* for anything else:
hand it an object without the attribute and the recursion guard silently resets
to the top level. The workflow runtime is exactly such an object — it is a
script executor, not an ``AIAgent``.

So this module never relies on that fallback. The owning depth is passed in as
an integer and validated before anything is spawned; a missing or nonsensical
depth raises rather than defaulting. The recursion cap
(``delegation.max_spawn_depth``) is then enforced here, before a child exists.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from agent.structured_output import (
    StructuredResult,
    coerce_structured_result,
    resolve_max_attempts,
    retry_instruction,
    schema_instruction,
)

logger = logging.getLogger(__name__)


class WorkflowDepthError(RuntimeError):
    """Raised when a workflow would spawn past the configured depth cap."""


class WorkflowAgentError(RuntimeError):
    """Raised when a workflow agent could not be run at all."""


@dataclass
class AgentOutcome:
    """Result of one ``agent()`` call inside a workflow script."""

    ok: bool
    value: Any = None
    error: Optional[str] = None
    label: Optional[str] = None
    status: str = "completed"
    attempts: int = 1
    summary: Optional[str] = None
    duration: float = 0.0
    api_calls: int = 0

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "ok": self.ok,
            "status": self.status,
            "attempts": self.attempts,
            "duration": self.duration,
            "api_calls": self.api_calls,
        }
        if self.label:
            payload["label"] = self.label
        if self.ok:
            payload["value"] = self.value
        else:
            payload["error"] = self.error
            if self.summary:
                payload["summary"] = self.summary[:2000]
        return payload


def resolve_child_depth(owner_depth: Any) -> int:
    """Validate the depth a workflow is running at, failing closed.

    ``owner_depth`` is the ``_delegate_depth`` of the agent that started the
    workflow (0 for a top-level session). Anything that is not a non-negative
    integer is a programming error in the caller, not something to paper over
    with a default — defaulting is precisely the bug this guards against.
    """
    if isinstance(owner_depth, bool) or not isinstance(owner_depth, int):
        raise WorkflowDepthError(
            f"workflow depth must be an explicit int, got {owner_depth!r}; "
            "refusing to spawn with an assumed depth"
        )
    if owner_depth < 0:
        raise WorkflowDepthError(f"workflow depth cannot be negative (got {owner_depth})")
    return owner_depth + 1


def check_depth_allowed(child_depth: int, max_spawn_depth: int) -> None:
    """Raise when spawning at ``child_depth`` would exceed the configured cap."""
    if child_depth > max_spawn_depth:
        raise WorkflowDepthError(
            f"workflow agents would run at depth {child_depth}, exceeding "
            f"delegation.max_spawn_depth={max_spawn_depth}. Raise that config "
            "value to allow deeper nesting (each level multiplies API cost)."
        )


def build_agent_goal(prompt: str, schema: Optional[Dict[str, Any]], context: Optional[str]) -> str:
    """Compose the child's goal text from prompt, optional context, and schema."""
    parts = [prompt.strip()]
    if context:
        parts.append(f"\n\nContext:\n{context.strip()}")
    if schema:
        parts.append(schema_instruction(schema))
    return "".join(parts)


def run_workflow_agent(
    prompt: str,
    *,
    owner_agent,
    owner_depth: int,
    schema: Optional[Dict[str, Any]] = None,
    context: Optional[str] = None,
    label: Optional[str] = None,
    model: Optional[str] = None,
    toolsets: Optional[List[str]] = None,
    max_iterations: Optional[int] = None,
    max_attempts: Any = None,
    task_index: int = 0,
    task_count: int = 1,
) -> AgentOutcome:
    """Run one subagent to completion and coerce its answer to ``schema``.

    Retries only when the child produced output that failed to parse/validate.
    A child that was interrupted or failed outright is not retried: re-running
    a crashed agent rarely fixes it and each attempt costs a full run.
    """
    from tools.delegate_tool import (
        _build_child_agent,
        _get_max_spawn_depth,
        _run_single_child,
    )

    if not prompt or not str(prompt).strip():
        raise WorkflowAgentError("agent() requires a non-empty prompt")

    child_depth = resolve_child_depth(owner_depth)
    check_depth_allowed(child_depth, _get_max_spawn_depth())

    attempts_allowed = resolve_max_attempts(max_attempts)
    goal = build_agent_goal(prompt, schema, context)

    last: Optional[StructuredResult] = None
    total_api_calls = 0
    total_duration = 0.0

    for attempt in range(1, attempts_allowed + 1):
        child = _build_child_agent(
            task_index=task_index,
            goal=goal,
            context=None,
            toolsets=toolsets,
            model=model,
            max_iterations=max_iterations or 0,
            task_count=task_count,
            parent_agent=owner_agent,
            role="leaf",
        )
        # Belt and braces: _build_child_agent derives depth from the parent it
        # was handed. Stamp the depth we validated so a child can never come
        # out shallower than the workflow that spawned it.
        try:
            setattr(child, "_delegate_depth", child_depth)
        except Exception:  # pragma: no cover - defensive
            logger.debug("Could not stamp _delegate_depth on workflow child", exc_info=True)

        result = _run_single_child(
            task_index=task_index,
            goal=goal,
            child=child,
            parent_agent=owner_agent,
        )

        total_api_calls += int(result.get("api_calls") or 0)
        total_duration += float(result.get("duration") or 0.0)
        status = str(result.get("status") or "completed")
        summary = result.get("summary") or ""

        if status != "completed":
            # Interrupted / failed: surface it rather than burning another run.
            return AgentOutcome(
                ok=False,
                error=f"subagent {status}",
                label=label,
                status=status,
                attempts=attempt,
                summary=summary,
                duration=round(total_duration, 2),
                api_calls=total_api_calls,
            )

        if not schema:
            return AgentOutcome(
                ok=True,
                value=summary,
                label=label,
                status=status,
                attempts=attempt,
                summary=summary,
                duration=round(total_duration, 2),
                api_calls=total_api_calls,
            )

        parsed = coerce_structured_result(summary, schema, attempts=attempt)
        if parsed.ok:
            return AgentOutcome(
                ok=True,
                value=parsed.value,
                label=label,
                status=status,
                attempts=attempt,
                summary=summary,
                duration=round(total_duration, 2),
                api_calls=total_api_calls,
            )

        last = parsed
        if attempt < attempts_allowed:
            logger.info(
                "Workflow agent %s returned unparseable output (%s); retrying %d/%d",
                label or task_index,
                parsed.error,
                attempt + 1,
                attempts_allowed,
            )
            goal = build_agent_goal(retry_instruction(parsed, schema), schema, context)

    return AgentOutcome(
        ok=False,
        error=(last.error if last else "subagent produced no usable output"),
        label=label,
        status="invalid_output",
        attempts=attempts_allowed,
        summary=(last.raw if last else None),
        duration=round(total_duration, 2),
        api_calls=total_api_calls,
    )
