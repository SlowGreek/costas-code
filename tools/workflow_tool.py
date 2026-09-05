"""The `workflow` tool — run a model-written orchestration script.

Service-gated on ``workflows.enabled``, which defaults to **true**: this is a
first-class capability, and a feature behind a flag nobody flips may as well not
exist.

The gate still earns its keep. Setting the flag false removes the tool's schema
from every API call (~700 tokens) rather than merely refusing to run, so users
who don't want workflows pay nothing for them. That is the Footprint Ladder's
rung 3 (service-gated tool): the runtime genuinely must live in core — it needs
the delegation depth guard, the agent budget, and the durable run store — but
the model-facing surface remains switchable at zero residual cost.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from tools.registry import registry

logger = logging.getLogger(__name__)


def _load_config() -> Dict[str, Any]:
    try:
        from hermes_cli.config import load_config

        cfg = load_config() or {}
    except Exception:  # pragma: no cover - config must never break a tool call
        return {}
    section = cfg.get("workflows")
    return section if isinstance(section, dict) else {}


def check_workflow_requirements() -> bool:
    """Gate: on unless explicitly disabled.

    A missing ``workflows`` section means the user has an older config that
    predates the feature — they should get it, not silently lose it. Only an
    explicit ``enabled: false`` removes the tool.
    """
    cfg = _load_config()
    if "enabled" not in cfg:
        return True
    return bool(cfg.get("enabled"))


def _owner_depth(parent_agent) -> int:
    """The depth the workflow itself runs at.

    Explicit and fail-closed by design: ``agent.workflow_agent`` refuses to
    spawn on a non-integer depth rather than assuming top level, because
    assuming top level is exactly how a recursion guard silently reopens.
    """
    depth = getattr(parent_agent, "_delegate_depth", None)
    if isinstance(depth, bool) or not isinstance(depth, int):
        return 0
    return depth


def workflow(
    action: str = "start",
    script: Optional[str] = None,
    run_id: Optional[str] = None,
    args: Optional[Dict[str, Any]] = None,
    workspace: Optional[str] = None,
    wait_seconds: Optional[int] = None,
    parent_agent=None,
) -> str:
    from agent import workflow_manager as manager
    from agent.workflow_runtime import WorkflowError
    from agent.workflow_state import WorkflowStore, list_runs

    cfg = _load_config()
    action = (action or "start").strip().lower()

    try:
        if action == "start":
            if not script or not script.strip():
                return json.dumps({"error": "workflow(action='start') requires a script"})

            run = manager.start_workflow(
                script,
                owner_agent=parent_agent,
                owner_depth=_owner_depth(parent_agent),
                config=cfg,
                args=args,
                workspace=workspace,
            )

            # A short optional wait lets quick workflows return their answer in
            # one call instead of forcing a poll.
            if wait_seconds:
                run.wait(min(int(wait_seconds), 120))
                if run.finished:
                    return json.dumps(_result_payload(run), default=str)

            return json.dumps(
                {
                    "run_id": run.run_id,
                    "status": run.state.status,
                    "message": (
                        "Workflow started in the background. Poll with "
                        f"workflow(action='status', run_id='{run.run_id}') and collect "
                        "it with action='result'."
                    ),
                    "max_agents": run.runtime.limits.max_agents,
                    "max_concurrency": run.runtime.limits.max_concurrency,
                },
                default=str,
            )

        if action in {"status", "result", "stop", "wait"}:
            if not run_id:
                return json.dumps({"error": f"workflow(action='{action}') requires run_id"})

            run = manager.get_run(run_id)

            if action == "stop":
                return json.dumps(
                    {"run_id": run_id, "stopped": manager.stop_run(run_id)}, default=str
                )

            if run is None:
                # Not in this process — fall back to what is on disk.
                stored = WorkflowStore(run_id).load()
                if stored is None:
                    return json.dumps({"error": f"no workflow run named {run_id!r}"})
                return json.dumps(
                    {
                        "run_id": stored.run_id,
                        "status": stored.status,
                        "agents_completed": len(stored.agents),
                        "api_calls": stored.api_calls,
                        "result": stored.result,
                        "error": stored.error,
                        "note": "run is not active in this process; resume it to continue",
                    },
                    default=str,
                )

            if action == "wait":
                run.wait(min(int(wait_seconds or 60), 300))

            if action == "result" or (action == "wait" and run.finished):
                if not run.finished:
                    return json.dumps(
                        {**run.snapshot(), "note": "still running; poll again"}, default=str
                    )
                return json.dumps(_result_payload(run), default=str)

            snapshot = run.snapshot()
            if action == "wait":
                from agent.pending_user_input import has_pending_user_input
                if has_pending_user_input():
                    snapshot["wait_released_for"] = "user_input"
                    snapshot["note"] = "Wait ended for pending user input; the workflow and its agents are still running."
            return json.dumps(snapshot, default=str)

        if action == "resume":
            if not run_id:
                return json.dumps({"error": "workflow(action='resume') requires run_id"})
            run = manager.resume_workflow(
                run_id,
                owner_agent=parent_agent,
                owner_depth=_owner_depth(parent_agent),
                config=cfg,
            )
            return json.dumps(
                {
                    "run_id": run.run_id,
                    "status": run.state.status,
                    "message": "Workflow resumed; finished agents are replayed, not re-run.",
                },
                default=str,
            )

        if action == "list":
            return json.dumps({"runs": list_runs()}, default=str)

        return json.dumps(
            {
                "error": (
                    f"unknown action {action!r}; expected start, status, result, "
                    "wait, stop, resume, or list"
                )
            }
        )

    except WorkflowError as exc:
        return json.dumps({"error": str(exc)})
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("workflow tool failed")
        return json.dumps({"error": f"{type(exc).__name__}: {exc}"})


def _result_payload(run) -> Dict[str, Any]:
    payload = run.snapshot()
    payload["result"] = run.state.result
    if run.state.error:
        payload["error"] = run.state.error
    return payload


WORKFLOW_SCHEMA = {
    "name": "workflow",
    "description": (
        "Run a dynamic workflow: a Python script YOU write that orchestrates many "
        "subagents, where the script holds the plan and the intermediate results "
        "instead of your context window. Use it for work that is too large or too "
        "structured for turn-by-turn delegation — a codebase-wide audit, a large "
        "migration, research whose sources must be cross-checked, or any task where "
        "findings should be adversarially verified by a second agent rather than "
        "graded by the agent that produced them.\n\n"
        "The script is Python with top-level await and two primitives:\n"
        "  agent(prompt, schema=..., label=..., optional=False) -> validated result\n"
        "  pipeline(items, fn) -> list of results, bounded concurrency, order kept\n"
        "Also available: args, json, math, re, and normal Python data handling. "
        "Imports, file access, and network calls are NOT available in the script — "
        "do that work inside an agent(), which runs with the normal tool approvals.\n\n"
        "Pass `schema` (JSON Schema) whenever you need to branch on a result; "
        "without it an agent returns prose. A failed agent inside pipeline() becomes "
        "None (filter afterwards); a failed bare agent() aborts the run unless you "
        "pass optional=True.\n\n"
        "Example:\n"
        "  found = await agent('List every .py file under gateway/.',\n"
        "                      schema={'type':'object','required':['files'],\n"
        "                              'properties':{'files':{'type':'array',\n"
        "                                            'items':{'type':'string'}}}})\n"
        "  audits = await pipeline(found['files'],\n"
        "      lambda f: agent(f'Audit {f} for missing auth.', schema=FINDING, label=f))\n"
        "  return [a for a in audits if a and a['severity'] == 'high']\n\n"
        "COST: every agent() is a separate API call. A 25-agent run costs roughly "
        "25 delegations. Start returns immediately; poll with action='status' and "
        "collect with action='result'."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["start", "status", "result", "wait", "stop", "resume", "list"],
                "description": (
                    "start: run a new script. status: progress snapshot. result: "
                    "final value (once finished). wait: block briefly then report. "
                    "stop: halt a run. resume: re-run a stored run, replaying agents "
                    "that already completed. list: recent runs."
                ),
            },
            "script": {
                "type": "string",
                "description": "The workflow script (action='start').",
            },
            "run_id": {
                "type": "string",
                "description": "Run to act on (all actions except start/list).",
            },
            "args": {
                "type": "object",
                "description": "JSON values exposed to the script as the `args` global.",
            },
            "workspace": {
                "type": "string",
                "description": (
                    "Directory the workflow concerns. Recorded so a resume can detect "
                    "that files changed underneath it."
                ),
            },
            "wait_seconds": {
                "type": "integer",
                "description": (
                    "With start: wait up to this long (max 120s) and return the result "
                    "directly if the run finishes. With wait: how long to block (max 300s)."
                ),
            },
        },
        "required": ["action"],
    },
}


registry.register(
    name="workflow",
    toolset="workflows",
    schema=WORKFLOW_SCHEMA,
    handler=lambda args, **kw: workflow(
        action=args.get("action", "start"),
        script=args.get("script"),
        run_id=args.get("run_id"),
        args=args.get("args"),
        workspace=args.get("workspace"),
        wait_seconds=args.get("wait_seconds"),
        parent_agent=kw.get("parent_agent"),
    ),
    check_fn=check_workflow_requirements,
    emoji="🧬",
)
