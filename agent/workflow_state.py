"""Durable run state for dynamic workflows, with safe resume.

A workflow can run for a long time across many agents, so an interrupted run
should not throw away the agents that already finished — each one is a paid API
call. This module persists per-agent results and replays them on resume.

The danger that shapes this design
----------------------------------
Naive replay is worse than no replay. The obvious scheme — hash each
``agent()`` call and reuse a cached result when the hash matches — silently
breaks when the script takes a *different path* on resume:

* an agent that was still in flight when the run stopped has no saved result,
  so it re-runs and may answer differently;
* the script branches on that answer;
* every subsequent call is now a different call than the one recorded, but
  positional replay happily hands it the old result.

The run then completes with confident, wrong data and no error. That failure is
worse than crashing, because nothing signals it.

So replay here is **sequence-verified**. Each call records its content hash in
order. On resume, call N must hash-match recorded entry N. The first mismatch
means the script diverged: replay stops permanently, the divergence is recorded
on the run, and every later call executes for real. Correctness is preserved at
the cost of re-running some agents — the right trade.

Content hashing also deliberately covers the prompt, schema, and options rather
than a call-site index, so editing the script invalidates affected entries
instead of mis-mapping them onto shifted line numbers.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from hermes_constants import get_hermes_home

logger = logging.getLogger(__name__)

STATE_VERSION = 1


def workflows_root() -> Path:
    """Profile-aware root for workflow run state."""
    return get_hermes_home() / "workflows"


def run_dir(run_id: str) -> Path:
    return workflows_root() / run_id


def new_run_id() -> str:
    return f"wf_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"


def call_signature(
    prompt: str,
    schema: Optional[Dict[str, Any]] = None,
    options: Optional[Dict[str, Any]] = None,
) -> str:
    """Stable content hash for one ``agent()`` call.

    Covers what determines the answer — prompt text, output schema, and the
    options that steer the child (model, toolsets, ...). Excludes ``label``,
    which is cosmetic, so relabelling does not invalidate a cached result.
    """
    payload = {
        "prompt": prompt or "",
        "schema": schema or None,
        "options": {k: v for k, v in sorted((options or {}).items()) if k != "label" and v is not None},
    }
    encoded = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:32]


@dataclass
class AgentRecord:
    index: int
    signature: str
    ok: bool
    label: Optional[str] = None
    value: Any = None
    error: Optional[str] = None
    status: str = "completed"
    api_calls: int = 0
    duration: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "signature": self.signature,
            "ok": self.ok,
            "label": self.label,
            "value": self.value,
            "error": self.error,
            "status": self.status,
            "api_calls": self.api_calls,
            "duration": self.duration,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AgentRecord":
        return cls(
            index=int(data.get("index", 0)),
            signature=str(data.get("signature", "")),
            ok=bool(data.get("ok", False)),
            label=data.get("label"),
            value=data.get("value"),
            error=data.get("error"),
            status=str(data.get("status", "completed")),
            api_calls=int(data.get("api_calls", 0)),
            duration=float(data.get("duration", 0.0)),
        )


@dataclass
class WorkflowState:
    run_id: str
    status: str = "running"
    script_sha: str = ""
    meta: Dict[str, Any] = field(default_factory=dict)
    args: Dict[str, Any] = field(default_factory=dict)
    agents: List[AgentRecord] = field(default_factory=list)
    result: Any = None
    error: Optional[str] = None
    diverged_at: Optional[int] = None
    started_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    workspace: Optional[str] = None
    workspace_fingerprint: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": STATE_VERSION,
            "run_id": self.run_id,
            "status": self.status,
            "script_sha": self.script_sha,
            "meta": self.meta,
            "args": self.args,
            "agents": [a.to_dict() for a in self.agents],
            "result": self.result,
            "error": self.error,
            "diverged_at": self.diverged_at,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "workspace": self.workspace,
            "workspace_fingerprint": self.workspace_fingerprint,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "WorkflowState":
        return cls(
            run_id=str(data.get("run_id", "")),
            status=str(data.get("status", "running")),
            script_sha=str(data.get("script_sha", "")),
            meta=data.get("meta") or {},
            args=data.get("args") or {},
            agents=[AgentRecord.from_dict(a) for a in (data.get("agents") or [])],
            result=data.get("result"),
            error=data.get("error"),
            diverged_at=data.get("diverged_at"),
            started_at=float(data.get("started_at", time.time())),
            updated_at=float(data.get("updated_at", time.time())),
            workspace=data.get("workspace"),
            workspace_fingerprint=data.get("workspace_fingerprint"),
        )

    @property
    def api_calls(self) -> int:
        return sum(a.api_calls for a in self.agents)


class WorkflowStore:
    """Reads and writes one run's ``state.json`` atomically."""

    def __init__(self, run_id: str, base_dir: Optional[Path] = None):
        self.run_id = run_id
        self.dir = Path(base_dir) if base_dir else run_dir(run_id)
        self._lock = threading.Lock()

    @property
    def state_path(self) -> Path:
        return self.dir / "state.json"

    @property
    def script_path(self) -> Path:
        return self.dir / "script.py"

    def ensure_dir(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)

    def write_script(self, source: str) -> None:
        self.ensure_dir()
        self.script_path.write_text(source, encoding="utf-8")

    def read_script(self) -> Optional[str]:
        try:
            return self.script_path.read_text(encoding="utf-8")
        except OSError:
            return None

    def save(self, state: WorkflowState) -> None:
        """Persist state atomically.

        Written to a temp file in the same directory and renamed, so a crash
        mid-write cannot leave a truncated ``state.json`` that would make the
        run unresumable — losing the very results this exists to protect.
        """
        self.ensure_dir()
        state.updated_at = time.time()
        payload = json.dumps(state.to_dict(), indent=2, default=str)

        with self._lock:
            handle, tmp_path = tempfile.mkstemp(dir=str(self.dir), prefix=".state-", suffix=".json")
            try:
                with os.fdopen(handle, "w", encoding="utf-8") as fh:
                    fh.write(payload)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp_path, self.state_path)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise

    def load(self) -> Optional[WorkflowState]:
        try:
            raw = self.state_path.read_text(encoding="utf-8")
        except OSError:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            logger.warning("workflow %s has unreadable state.json; ignoring", self.run_id)
            return None
        return WorkflowState.from_dict(data)


class ReplayLog:
    """Sequence-verified replay of a previous run's agent results.

    Hands back a recorded result only while the *ordered sequence* of call
    signatures still matches the previous run. The first mismatch disables
    replay for the rest of the run — see the module docstring for why silent
    positional replay is dangerous.
    """

    def __init__(self, previous: Optional[List[AgentRecord]] = None):
        self._previous = list(previous or [])
        self._cursor = 0
        self._active = bool(self._previous)
        self.diverged_at: Optional[int] = None
        self.replayed = 0

    @property
    def active(self) -> bool:
        return self._active

    def next_result(self, signature: str) -> Optional[AgentRecord]:
        """Return the recorded result for this call, or ``None`` to run it.

        ``None`` means "execute for real" — either replay is exhausted, already
        disabled by an earlier divergence, or this call does not match what was
        recorded at this position.
        """
        if not self._active:
            return None

        if self._cursor >= len(self._previous):
            # Past the end of the recording: everything from here is new work.
            self._active = False
            return None

        record = self._previous[self._cursor]
        if record.signature != signature:
            # Divergence. Stop replaying entirely rather than risk mapping old
            # results onto different calls.
            self.diverged_at = self._cursor
            self._active = False
            logger.info(
                "workflow replay diverged at call %d; re-running the remainder",
                self._cursor,
            )
            return None

        self._cursor += 1
        self.replayed += 1
        return record

    def note_executed(self) -> None:
        """Record that a call ran for real, keeping the cursor aligned.

        Once replay is inactive this is a no-op; it exists so a partially
        replayed run still advances past entries it consumed.
        """
        if self._active:
            self._cursor += 1


def workspace_fingerprint(path: Optional[str]) -> Optional[str]:
    """Cheap marker of a workspace's state, for resume sanity checks.

    A cached "file X has no bug" replayed against a file edited since the run
    stopped is a confident wrong answer. This does not prevent that on its own;
    it lets a resume *notice* the tree moved and say so.
    """
    if not path:
        return None
    target = Path(path)
    if not target.exists():
        return None

    try:
        newest = 0.0
        count = 0
        for root, dirs, files in os.walk(target):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d != "node_modules"]
            for name in files:
                if name.startswith("."):
                    continue
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(root, name)))
                    count += 1
                except OSError:
                    continue
                if count >= 5000:  # bounded: this is a heuristic, not an audit
                    break
            if count >= 5000:
                break
        return hashlib.sha256(f"{count}:{int(newest)}".encode()).hexdigest()[:16]
    except OSError:
        return None


def list_runs(limit: int = 20) -> List[Dict[str, Any]]:
    """Recent runs, newest first."""
    root = workflows_root()
    if not root.is_dir():
        return []

    runs: List[Dict[str, Any]] = []
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        state = WorkflowStore(entry.name, base_dir=entry).load()
        if state is None:
            continue
        runs.append(
            {
                "run_id": state.run_id,
                "status": state.status,
                "name": (state.meta or {}).get("name"),
                "agents": len(state.agents),
                "api_calls": state.api_calls,
                "started_at": state.started_at,
                "updated_at": state.updated_at,
            }
        )

    runs.sort(key=lambda r: r["updated_at"], reverse=True)
    return runs[:limit]
