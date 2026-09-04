"""Workflow run manager: start, watch, stop, and resume dynamic workflows.

Owns the lifecycle around :class:`~agent.workflow_runtime.WorkflowRuntime`:
persisting each run, executing it off the caller's thread, and reconstructing a
replay log when a run is resumed.

Why runs are backgrounded
-------------------------
A workflow can spawn dozens of agents over many minutes. Blocking the tool call
that started it would hold the agent's tool-executor thread for the whole run,
starve the conversation, and blow every timeout between here and the provider.
So ``start`` returns a run id immediately and the work proceeds on a daemon
thread; the model polls ``status`` and collects ``result``. That is also what
makes the context savings real — the conversation stays free while agents work.

Durability boundary, stated plainly
-----------------------------------
Runs are process-local. State is written to disk continuously, so a run that is
interrupted can be *resumed* later, but nothing resurrects it automatically: if
Hermes exits mid-run, the run is marked interrupted on next inspection and the
user (or model) must resume it explicitly. Cron remains the tool for work that
must survive a restart on its own.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional

from agent.workflow_runtime import (
    WorkflowLimits,
    WorkflowRuntime,
    WorkflowScriptError,
    extract_meta,
    validate_script,
)
from agent.workflow_state import (
    AgentRecord,
    ReplayLog,
    WorkflowState,
    WorkflowStore,
    new_run_id,
    workspace_fingerprint,
)

logger = logging.getLogger(__name__)

_RUNS: Dict[str, "WorkflowRun"] = {}
_RUNS_LOCK = threading.Lock()


def _script_sha(source: str) -> str:
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:16]


class WorkflowRun:
    """One executing workflow: its thread, runtime, and persisted state."""

    def __init__(
        self,
        run_id: str,
        source: str,
        *,
        owner_agent,
        owner_depth: int,
        limits: WorkflowLimits,
        args: Optional[Dict[str, Any]] = None,
        workspace: Optional[str] = None,
        timeout_seconds: int = 0,
        previous_agents: Optional[List[AgentRecord]] = None,
        agent_runner: Optional[Callable[..., Any]] = None,
    ):
        self.run_id = run_id
        self.source = source
        self.store = WorkflowStore(run_id)
        self.timeout_seconds = timeout_seconds
        self._thread: Optional[threading.Thread] = None
        self._done = threading.Event()

        self.state = WorkflowState(
            run_id=run_id,
            status="running",
            script_sha=_script_sha(source),
            meta=extract_meta(source),
            args=dict(args or {}),
            workspace=workspace,
            workspace_fingerprint=workspace_fingerprint(workspace),
        )

        replay = ReplayLog(previous_agents) if previous_agents else None
        runtime_kwargs: Dict[str, Any] = {
            "owner_agent": owner_agent,
            "owner_depth": owner_depth,
            "limits": limits,
            "args": args,
            "replay": replay,
            "on_agent_record": self._persist_agent,
            "on_event": self._on_event,
        }
        if agent_runner is not None:
            runtime_kwargs["agent_runner"] = agent_runner

        self.runtime = WorkflowRuntime(**runtime_kwargs)
        self.events: List[Dict[str, Any]] = []

    # ── persistence ───────────────────────────────────────────────────────

    def _persist_agent(self, record: AgentRecord) -> None:
        """Write each agent result as it lands, so a crash loses at most one."""
        self.state.agents.append(record)
        try:
            self.store.save(self.state)
        except OSError:
            logger.debug("workflow %s: could not persist agent record", self.run_id, exc_info=True)

    def _on_event(self, event: Dict[str, Any]) -> None:
        event["at"] = time.time()
        self.events.append(event)
        # Bounded: a 500-agent run would otherwise grow this without limit.
        if len(self.events) > 2000:
            del self.events[:1000]

    # ── execution ─────────────────────────────────────────────────────────

    def start(self) -> None:
        self.store.ensure_dir()
        self.store.write_script(self.source)
        self.store.save(self.state)

        self._thread = threading.Thread(
            target=self._run, name=f"workflow-{self.run_id}", daemon=True
        )
        self._thread.start()

    def _run(self) -> None:
        watchdog: Optional[threading.Timer] = None
        if self.timeout_seconds and self.timeout_seconds > 0:
            watchdog = threading.Timer(self.timeout_seconds, self._on_timeout)
            watchdog.daemon = True
            watchdog.start()

        try:
            result = self.runtime.run(self.source)
            self.state.result = result.value
            # An explicit stop or a timeout is the authoritative outcome: the
            # script's own error ("workflow was stopped") is a consequence of
            # it, and overwriting the reason here would erase why the run
            # ended.
            if self.state.status in {"stopped", "timeout"}:
                pass
            else:
                self.state.error = result.error
                self.state.status = "completed" if result.ok else "failed"
            self.state.diverged_at = self.runtime.diverged_at
        except Exception as exc:  # pragma: no cover - defensive
            self.state.status = "failed"
            self.state.error = f"{type(exc).__name__}: {exc}"
            logger.exception("workflow %s crashed", self.run_id)
        finally:
            if watchdog is not None:
                watchdog.cancel()
            try:
                self.store.save(self.state)
            except OSError:
                logger.debug("workflow %s: final save failed", self.run_id, exc_info=True)
            self._done.set()

    def _on_timeout(self) -> None:
        logger.warning("workflow %s exceeded %ss; stopping", self.run_id, self.timeout_seconds)
        self.state.status = "timeout"
        self.state.error = f"workflow exceeded its {self.timeout_seconds}s time limit"
        self.runtime.stop()

    def stop(self) -> None:
        self.state.status = "stopped"
        self.state.error = "workflow was stopped"
        self.runtime.stop()
        try:
            self.store.save(self.state)
        except OSError:
            pass

    def wait(self, timeout: Optional[float] = None) -> bool:
        """Yield a wait to user input without stopping the workflow/children."""
        from agent.pending_user_input import has_pending_user_input
        import time
        deadline = None if timeout is None else time.monotonic() + max(0, timeout)
        while not self._done.is_set():
            if has_pending_user_input():
                return False
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                return False
            self._done.wait(min(1.0, remaining) if remaining is not None else 1.0)
        return True

    @property
    def finished(self) -> bool:
        return self._done.is_set()

    def snapshot(self) -> Dict[str, Any]:
        """Progress summary safe to hand to the model."""
        agents = self.state.agents
        failed = [a for a in agents if not a.ok]
        payload: Dict[str, Any] = {
            "run_id": self.run_id,
            "status": self.state.status,
            "name": (self.state.meta or {}).get("name"),
            "agents_completed": len(agents),
            "agents_failed": len(failed),
            "api_calls": self.state.api_calls,
            "elapsed": round(time.time() - self.state.started_at, 1),
            "replayed": self.runtime.replayed_agents,
        }
        if self.state.diverged_at is not None:
            payload["diverged_at"] = self.state.diverged_at
        if failed:
            payload["recent_failures"] = [
                {"label": a.label, "error": a.error, "status": a.status} for a in failed[-5:]
            ]
        return payload


# ── module-level registry ────────────────────────────────────────────────


def start_workflow(
    source: str,
    *,
    owner_agent,
    owner_depth: int,
    config: Optional[Dict[str, Any]] = None,
    args: Optional[Dict[str, Any]] = None,
    workspace: Optional[str] = None,
    agent_runner: Optional[Callable[..., Any]] = None,
) -> WorkflowRun:
    """Validate, persist, and begin executing a workflow script."""
    cfg = config or {}
    validate_script(source)  # fail fast, before a run id or directory exists

    run = WorkflowRun(
        new_run_id(),
        source,
        owner_agent=owner_agent,
        owner_depth=owner_depth,
        limits=WorkflowLimits.from_config(cfg),
        args=args,
        workspace=workspace,
        timeout_seconds=int(cfg.get("timeout_seconds") or 0),
        agent_runner=agent_runner,
    )

    with _RUNS_LOCK:
        _RUNS[run.run_id] = run

    run.start()
    return run


def resume_workflow(
    run_id: str,
    *,
    owner_agent,
    owner_depth: int,
    config: Optional[Dict[str, Any]] = None,
    agent_runner: Optional[Callable[..., Any]] = None,
) -> WorkflowRun:
    """Re-execute a stored run, replaying agents that already finished.

    Replay is sequence-verified (see :mod:`agent.workflow_state`): the moment
    the resumed script's calls stop matching the recording, replay is abandoned
    and the rest of the run executes for real.
    """
    store = WorkflowStore(run_id)
    previous = store.load()
    if previous is None:
        raise WorkflowScriptError(f"no stored workflow run named {run_id!r}")

    source = store.read_script()
    if not source:
        raise WorkflowScriptError(f"workflow run {run_id!r} has no saved script")

    cfg = config or {}
    run = WorkflowRun(
        run_id,
        source,
        owner_agent=owner_agent,
        owner_depth=owner_depth,
        limits=WorkflowLimits.from_config(cfg),
        args=previous.args,
        workspace=previous.workspace,
        timeout_seconds=int(cfg.get("timeout_seconds") or 0),
        previous_agents=previous.agents,
        agent_runner=agent_runner,
    )

    # Surface a workspace that moved under us: replayed findings about files
    # that have since changed are confidently wrong, and silence is the worst
    # possible handling.
    current_fingerprint = workspace_fingerprint(previous.workspace)
    if previous.workspace_fingerprint and current_fingerprint != previous.workspace_fingerprint:
        run.state.meta = dict(run.state.meta or {})
        run.state.meta["workspace_changed_since_run"] = True
        logger.warning(
            "workflow %s resumed against a changed workspace; replayed results may be stale",
            run_id,
        )

    with _RUNS_LOCK:
        _RUNS[run_id] = run

    run.start()
    return run


def get_run(run_id: str) -> Optional[WorkflowRun]:
    with _RUNS_LOCK:
        return _RUNS.get(run_id)


def active_runs() -> List[WorkflowRun]:
    with _RUNS_LOCK:
        return [r for r in _RUNS.values() if not r.finished]


def stop_run(run_id: str) -> bool:
    run = get_run(run_id)
    if run is None:
        return False
    run.stop()
    return True


def reset_registry() -> None:
    """Clear the in-process registry (tests)."""
    with _RUNS_LOCK:
        _RUNS.clear()
