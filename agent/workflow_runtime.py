"""Dynamic workflow runtime: execute a model-written orchestration script.

A *dynamic workflow* is a script that orchestrates many subagents where the
**script** holds the plan — the loop, the branching, and the intermediate
results — instead of the model's context window. The model writes the script
once; the runtime executes it; only the final return value goes back into the
conversation.

That inversion is the whole point. With ordinary delegation the model decides
turn by turn what to spawn next and every child's summary lands in context. Over
a long fan-out that invites three well-documented failure modes: stopping early
and declaring done ("agentic laziness"), preferring one's own findings when
asked to verify them ("self-preferential bias"), and losing constraints across
compaction ("goal drift"). Moving the plan into code fixes the first and third
structurally, and makes the second fixable by having a *separate* agent grade
each result — the adversarial-verification pattern.

Script surface
--------------
The script is Python with two async primitives plus ``args``/``meta``::

    meta = {"name": "audit-routes"}

    found = await agent("List every .py file under gateway/.", schema=FILES)

    audits = await pipeline(
        found["files"],
        lambda f: agent(f"Audit {f} for missing auth.", schema=FINDING, label=f),
    )

    return [a for a in audits if a and a["severity"] == "high"]

``agent()`` runs one subagent and returns its validated JSON. ``pipeline()``
maps a callable over a list with bounded concurrency and returns results in
input order.

On isolation — read this before trusting it
-------------------------------------------
The script executes with ``__builtins__`` reduced to a small allow-list and no
import machinery. **This is a guardrail against model mistakes, not a security
boundary.** CPython cannot sandbox untrusted code in-process; escapes via
``().__class__.__bases__[0].__subclasses__()`` and friends are one line each,
which is why ``rexec``/``Bastion`` were removed from the standard library. Do
not describe this as containment.

The actual control is the same one ``execute_code`` relies on: the *whole
script* is surfaced for approval before it runs, and every side effect happens
inside a subagent where the normal per-tool approval path applies. The runtime
itself performs no file, network, or process operations on the script's behalf.

Failure semantics
-----------------
``pipeline()`` never raises for a single failed item. A failed ``agent()``
yields ``None`` in the results list, matching the ``.filter(Boolean)`` shape
these scripts are written around, and the failure is recorded on the run for
inspection. A bare ``agent()`` call returns its value directly and raises
:class:`WorkflowAgentFailed` on failure, so a script that depends on one
critical step fails loudly instead of silently threading ``None`` onward.
"""

from __future__ import annotations

import ast
import asyncio
import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from agent.workflow_agent import AgentOutcome, run_workflow_agent

logger = logging.getLogger(__name__)

# Defaults chosen to bound cost, not capability. Every agent is a real API call,
# so a runaway loop is a runaway bill; these are the ceilings a script cannot
# talk its way past.
DEFAULT_MAX_AGENTS = 25
DEFAULT_MAX_CONCURRENCY = 8
HARD_MAX_AGENTS = 500
HARD_MAX_CONCURRENCY = 32

# Names the script may use. Deliberately small: orchestration needs data
# manipulation, not I/O. Anything that touches the world belongs in an agent.
_ALLOWED_BUILTINS = (
    "abs all any bool dict divmod enumerate filter float format frozenset int "
    "isinstance len list map max min print range repr reversed round set "
    "sorted str sum tuple zip True False None"
).split()


class WorkflowError(RuntimeError):
    """Base class for workflow authoring/runtime errors."""


class WorkflowScriptError(WorkflowError):
    """The script is malformed or uses a forbidden construct."""


class WorkflowAgentFailed(WorkflowError):
    """A bare ``agent()`` call failed and the script did not tolerate it."""


class WorkflowLimitExceeded(WorkflowError):
    """The run hit its agent-count ceiling."""


@dataclass
class WorkflowLimits:
    max_agents: int = DEFAULT_MAX_AGENTS
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY

    @classmethod
    def from_config(cls, cfg: Optional[Dict[str, Any]] = None) -> "WorkflowLimits":
        cfg = cfg or {}
        return cls(
            max_agents=_clamp(cfg.get("max_agents"), DEFAULT_MAX_AGENTS, 1, HARD_MAX_AGENTS),
            max_concurrency=_clamp(
                cfg.get("max_concurrency"), DEFAULT_MAX_CONCURRENCY, 1, HARD_MAX_CONCURRENCY
            ),
        )


def _clamp(value: Any, default: int, low: int, high: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(parsed, high))


@dataclass
class WorkflowRunResult:
    ok: bool
    value: Any = None
    error: Optional[str] = None
    agents_run: int = 0
    api_calls: int = 0
    failures: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "ok": self.ok,
            "agents_run": self.agents_run,
            "api_calls": self.api_calls,
        }
        if self.ok:
            payload["result"] = self.value
        else:
            payload["error"] = self.error
        if self.failures:
            payload["failures"] = self.failures[:20]
            payload["failure_count"] = len(self.failures)
        return payload


# Constructs that are always a mistake in an orchestration script. Blocking them
# is about catching model errors early with a clear message — not containment
# (see the module docstring).
_FORBIDDEN_NODES = {
    ast.Import: "imports are not available; use agent() for anything external",
    ast.ImportFrom: "imports are not available; use agent() for anything external",
    ast.Global: "global statements are not allowed in a workflow script",
    ast.Nonlocal: "nonlocal statements are not allowed in a workflow script",
}

_FORBIDDEN_NAMES = {
    "__import__": "dynamic import is not available",
    "eval": "eval() is not available",
    "exec": "exec() is not available",
    "compile": "compile() is not available",
    "open": "file access is not available; do file work inside an agent()",
    "input": "interactive input is not available in a workflow",
    "globals": "globals() is not available",
    "locals": "locals() is not available",
    "vars": "vars() is not available",
    "getattr": "getattr() is not available",
    "setattr": "setattr() is not available",
    "delattr": "delattr() is not available",
}


def validate_script(source: str) -> ast.Module:
    """Parse the script and reject constructs that are always authoring errors.

    Raises :class:`WorkflowScriptError` with a message aimed at the model that
    wrote the script, so a bad generation can be corrected on the next turn.
    """
    if not source or not source.strip():
        raise WorkflowScriptError("workflow script is empty")

    try:
        tree = ast.parse(source, filename="<workflow>", mode="exec")
    except SyntaxError as exc:
        raise WorkflowScriptError(f"workflow script has a syntax error: {exc}") from exc

    for node in ast.walk(tree):
        for node_type, message in _FORBIDDEN_NODES.items():
            if isinstance(node, node_type):
                raise WorkflowScriptError(f"line {getattr(node, 'lineno', '?')}: {message}")

        if isinstance(node, ast.Name) and node.id in _FORBIDDEN_NAMES:
            raise WorkflowScriptError(
                f"line {getattr(node, 'lineno', '?')}: {_FORBIDDEN_NAMES[node.id]}"
            )

        # Dunder attribute access is the standard route out of a stripped
        # namespace. Blocking it keeps honest scripts honest.
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise WorkflowScriptError(
                f"line {getattr(node, 'lineno', '?')}: dunder attribute "
                f"access ({node.attr}) is not allowed in a workflow script"
            )

    return tree


def extract_meta(source: str) -> Dict[str, Any]:
    """Read the script's ``meta = {...}`` block without executing anything."""
    try:
        tree = ast.parse(source, filename="<workflow>", mode="exec")
    except SyntaxError:
        return {}

    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "meta":
                    try:
                        value = ast.literal_eval(node.value)
                    except (ValueError, TypeError):
                        return {}
                    return value if isinstance(value, dict) else {}
    return {}


class WorkflowRuntime:
    """Executes one workflow script, owning its budget and concurrency."""

    def __init__(
        self,
        *,
        owner_agent,
        owner_depth: int,
        limits: Optional[WorkflowLimits] = None,
        args: Optional[Dict[str, Any]] = None,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
        agent_runner: Callable[..., AgentOutcome] = run_workflow_agent,
    ):
        self.owner_agent = owner_agent
        self.owner_depth = owner_depth
        self.limits = limits or WorkflowLimits()
        self.args = args or {}
        self.on_event = on_event
        self._agent_runner = agent_runner

        self._lock = threading.Lock()
        self._agents_started = 0
        self._api_calls = 0
        self._failures: List[Dict[str, Any]] = []
        self._stop = threading.Event()

    # ── budget ────────────────────────────────────────────────────────────

    def _claim_agent_slot(self, label: Optional[str]) -> int:
        """Reserve one agent against the run budget, or refuse.

        Claiming *before* spawning is what makes the cap real: a script that
        loops forever is stopped at the ceiling rather than after it.
        """
        with self._lock:
            if self._agents_started >= self.limits.max_agents:
                raise WorkflowLimitExceeded(
                    f"workflow reached its agent limit ({self.limits.max_agents}). "
                    "Raise workflows.max_agents if this task genuinely needs more "
                    "(each agent is a separate API call)."
                )
            self._agents_started += 1
            return self._agents_started

    def _record(self, outcome: AgentOutcome) -> None:
        with self._lock:
            self._api_calls += outcome.api_calls
            if not outcome.ok:
                self._failures.append(outcome.to_dict())

    def _emit(self, event: Dict[str, Any]) -> None:
        if not self.on_event:
            return
        try:
            self.on_event(event)
        except Exception:  # pragma: no cover - observers must not break runs
            logger.debug("workflow event observer raised", exc_info=True)

    def stop(self) -> None:
        self._stop.set()

    # ── script-facing primitives ──────────────────────────────────────────

    async def agent(
        self,
        prompt: str,
        *,
        schema: Optional[Dict[str, Any]] = None,
        label: Optional[str] = None,
        context: Optional[str] = None,
        model: Optional[str] = None,
        toolsets: Optional[List[str]] = None,
        max_iterations: Optional[int] = None,
        max_attempts: Any = None,
        optional: bool = False,
    ) -> Any:
        """Run one subagent and return its validated result.

        Raises :class:`WorkflowAgentFailed` when the agent fails, unless
        ``optional=True`` — a bare call is usually load-bearing, so failing
        loudly beats threading ``None`` into later steps. ``pipeline()`` uses
        ``optional=True`` internally so one bad item cannot kill a fan-out.
        """
        if self._stop.is_set():
            raise WorkflowError("workflow was stopped")

        index = self._claim_agent_slot(label)
        self._emit({"type": "agent_start", "index": index, "label": label})

        outcome = await asyncio.to_thread(
            self._agent_runner,
            prompt,
            owner_agent=self.owner_agent,
            owner_depth=self.owner_depth,
            schema=schema,
            context=context,
            label=label,
            model=model,
            toolsets=toolsets,
            max_iterations=max_iterations,
            max_attempts=max_attempts,
            task_index=index - 1,
        )

        self._record(outcome)
        self._emit(
            {
                "type": "agent_end",
                "index": index,
                "label": label,
                "ok": outcome.ok,
                "status": outcome.status,
            }
        )

        if outcome.ok:
            return outcome.value
        if optional:
            return None
        raise WorkflowAgentFailed(
            f"agent{f' [{label}]' if label else ''} failed: {outcome.error}"
        )

    async def pipeline(self, items: Any, fn: Callable[..., Any]) -> List[Any]:
        """Map ``fn`` over ``items`` with bounded concurrency, order preserved.

        A failing item becomes ``None`` rather than aborting the batch — the
        fan-out shape these scripts use expects to filter afterwards.
        """
        if not isinstance(items, (list, tuple)):
            raise WorkflowScriptError("pipeline() requires a list")

        items = list(items)
        if not items:
            return []

        semaphore = asyncio.Semaphore(self.limits.max_concurrency)
        accepts_index = _accepts_two_args(fn)

        async def _run_one(item: Any, index: int) -> Any:
            async with semaphore:
                if self._stop.is_set():
                    return None
                try:
                    called = fn(item, index) if accepts_index else fn(item)
                    return await called if asyncio.iscoroutine(called) else called
                except WorkflowLimitExceeded:
                    # The budget ceiling is a run-level condition, not an item
                    # failure — let it stop the whole pipeline.
                    raise
                except WorkflowError as exc:
                    logger.info("workflow pipeline item %d failed: %s", index, exc)
                    return None

        return await asyncio.gather(*[_run_one(item, i) for i, item in enumerate(items)])

    # ── execution ─────────────────────────────────────────────────────────

    def _namespace(self) -> Dict[str, Any]:
        safe_builtins = {name: __builtins__[name] for name in _ALLOWED_BUILTINS
                         if isinstance(__builtins__, dict) and name in __builtins__}
        if not safe_builtins:  # __builtins__ is a module under normal imports
            import builtins as _b

            safe_builtins = {n: getattr(_b, n) for n in _ALLOWED_BUILTINS if hasattr(_b, n)}

        import json as _json
        import math as _math
        import re as _re

        return {
            "__builtins__": safe_builtins,
            "agent": self.agent,
            "pipeline": self.pipeline,
            "args": dict(self.args),
            "json": _json,
            "math": _math,
            "re": _re,
        }

    async def _execute(self, source: str) -> Any:
        validate_script(source)

        namespace = self._namespace()
        # Wrap in an async function so the script may use top-level await and
        # `return`, matching the shape these scripts are written in.
        indented = "\n".join(f"    {line}" for line in source.splitlines())
        wrapper = f"async def __workflow__():\n{indented}\n"

        try:
            compiled = compile(wrapper, "<workflow>", "exec")
        except SyntaxError as exc:
            raise WorkflowScriptError(f"workflow script has a syntax error: {exc}") from exc

        exec(compiled, namespace)  # noqa: S102 - approved script, see module docstring
        return await namespace["__workflow__"]()

    def run(self, source: str) -> WorkflowRunResult:
        """Execute ``source`` to completion and return a structured result."""
        try:
            value = asyncio.run(self._execute(source))
            ok, error = True, None
        except WorkflowError as exc:
            value, ok, error = None, False, str(exc)
        except Exception as exc:  # script bugs land here
            value, ok, error = None, False, f"{type(exc).__name__}: {exc}"
            logger.info("workflow script raised", exc_info=True)

        return WorkflowRunResult(
            ok=ok,
            value=value,
            error=error,
            agents_run=self._agents_started,
            api_calls=self._api_calls,
            failures=list(self._failures),
        )


def _accepts_two_args(fn: Callable[..., Any]) -> bool:
    """True when ``fn`` takes ``(item, index)`` rather than just ``(item)``."""
    import inspect

    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return False

    positional = [
        p
        for p in signature.parameters.values()
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
    ]
    return len(positional) >= 2
