"""Tests for the workflow manager and the service-gated `workflow` tool.

The gate tests matter for footprint: while workflows.enabled is false the tool
must not exist at all, so its (long) schema is never sent to the model.
"""

import json
import time
from unittest.mock import patch

import pytest

from agent import workflow_manager as manager
from agent.workflow_agent import AgentOutcome
from agent.workflow_state import WorkflowStore, workflows_root


@pytest.fixture(autouse=True)
def _clean_registry():
    manager.reset_registry()
    yield
    manager.reset_registry()


def _ok(value, api_calls=1):
    return AgentOutcome(ok=True, value=value, api_calls=api_calls)


def _start(script, **kwargs):
    return manager.start_workflow(
        script,
        owner_agent=object(),
        owner_depth=0,
        agent_runner=kwargs.pop("runner", lambda p, **k: _ok(p)),
        config=kwargs.pop("config", {"max_agents": 20, "max_concurrency": 4}),
        **kwargs,
    )


class TestStartWorkflow:
    def test_run_completes_and_persists_its_result(self):
        run = _start('return await agent("hello")')
        assert run.wait(10)
        assert run.state.status == "completed"
        assert run.state.result == "hello"

        stored = WorkflowStore(run.run_id).load()
        assert stored.status == "completed"
        assert stored.result == "hello"

    def test_script_is_saved_for_inspection_and_resume(self):
        run = _start('return await agent("x")')
        run.wait(10)
        assert WorkflowStore(run.run_id).read_script() == 'return await agent("x")'

    def test_agent_records_are_persisted_as_they_land(self):
        run = _start('return await pipeline(["a","b","c"], lambda f: agent(f))')
        run.wait(10)
        stored = WorkflowStore(run.run_id).load()
        assert len(stored.agents) == 3
        assert stored.api_calls == 3

    def test_invalid_script_is_rejected_before_a_run_exists(self):
        from agent.workflow_runtime import WorkflowScriptError

        before = set((workflows_root().iterdir() if workflows_root().is_dir() else []))
        with pytest.raises(WorkflowScriptError):
            _start("import os\nreturn 1")
        after = set((workflows_root().iterdir() if workflows_root().is_dir() else []))
        assert before == after

    def test_meta_is_recorded(self):
        run = _start('meta = {"name": "audit"}\nreturn await agent("x")')
        run.wait(10)
        assert run.state.meta["name"] == "audit"

    def test_failing_script_is_marked_failed(self):
        run = _start("return 1 / 0")
        run.wait(10)
        assert run.state.status == "failed"
        assert "ZeroDivisionError" in run.state.error


class TestStopAndTimeout:
    def test_stop_halts_a_running_workflow(self):
        def slow(prompt, **_kwargs):
            time.sleep(0.3)
            return _ok(prompt)

        run = _start(
            'return await pipeline([str(i) for i in range(20)], lambda f: agent(f))',
            runner=slow,
            config={"max_agents": 20, "max_concurrency": 2},
        )
        time.sleep(0.1)
        manager.stop_run(run.run_id)
        run.wait(10)

        assert run.state.status == "stopped"

    def test_timeout_marks_the_run_and_stops_it(self):
        def slow(prompt, **_kwargs):
            time.sleep(0.2)
            return _ok(prompt)

        run = _start(
            'return await pipeline([str(i) for i in range(30)], lambda f: agent(f))',
            runner=slow,
            config={"max_agents": 30, "max_concurrency": 1, "timeout_seconds": 1},
        )
        run.wait(15)
        assert run.state.status == "timeout"
        assert "time limit" in run.state.error


class TestResume:
    def test_resume_replays_finished_agents(self):
        calls = {"n": 0}

        def runner(prompt, **_kwargs):
            calls["n"] += 1
            return _ok(prompt)

        run = _start('return await pipeline(["a","b"], lambda f: agent(f))', runner=runner)
        run.wait(10)
        assert calls["n"] == 2

        calls["n"] = 0
        resumed = manager.resume_workflow(
            run.run_id, owner_agent=object(), owner_depth=0, agent_runner=runner,
            config={"max_agents": 20, "max_concurrency": 4},
        )
        resumed.wait(10)

        assert resumed.state.result == ["a", "b"]
        assert calls["n"] == 0  # everything replayed

    def test_resume_of_unknown_run_is_an_error(self):
        from agent.workflow_runtime import WorkflowScriptError

        with pytest.raises(WorkflowScriptError):
            manager.resume_workflow("wf_does_not_exist", owner_agent=object(), owner_depth=0)

    def test_changed_workspace_is_flagged_on_resume(self, tmp_path):
        # A replayed "file X is clean" against an edited tree is confidently
        # wrong; the resume must at least notice.
        (tmp_path / "a.txt").write_text("one")
        run = _start('return await agent("x")', workspace=str(tmp_path))
        run.wait(10)

        (tmp_path / "b.txt").write_text("two")
        resumed = manager.resume_workflow(
            run.run_id, owner_agent=object(), owner_depth=0,
            agent_runner=lambda p, **k: _ok(p),
        )
        resumed.wait(10)
        assert resumed.state.meta.get("workspace_changed_since_run") is True


class TestSnapshot:
    def test_snapshot_reports_progress_and_failures(self):
        def runner(prompt, **_kwargs):
            if prompt == "b":
                return AgentOutcome(ok=False, error="bad json", status="invalid_output")
            return _ok(prompt)

        run = _start('return await pipeline(["a","b"], lambda f: agent(f))', runner=runner)
        run.wait(10)

        snap = run.snapshot()
        assert snap["agents_completed"] == 2
        assert snap["agents_failed"] == 1
        assert snap["recent_failures"][0]["error"] == "bad json"


class TestServiceGate:
    def test_explicitly_disabling_removes_the_tool(self):
        # The gate's value: false removes ~700 tokens of schema from EVERY API
        # call, not merely refusing to run.
        from tools.workflow_tool import check_workflow_requirements

        with patch("tools.workflow_tool._load_config", return_value={"enabled": False}):
            assert check_workflow_requirements() is False

    def test_enabled_by_default(self):
        from tools.workflow_tool import check_workflow_requirements
        from hermes_cli.config import DEFAULT_CONFIG

        assert DEFAULT_CONFIG["workflows"]["enabled"] is True
        with patch("tools.workflow_tool._load_config", return_value={"enabled": True}):
            assert check_workflow_requirements() is True

    def test_config_predating_the_feature_still_gets_it(self):
        # An older config has no `workflows` section; absence must not read as
        # "disabled" or upgrading users would silently lose the feature.
        from tools.workflow_tool import check_workflow_requirements

        with patch("tools.workflow_tool._load_config", return_value={}):
            assert check_workflow_requirements() is True

    def test_registered_in_the_workflows_toolset(self):
        from toolsets import TOOLSETS

        assert "workflow" in TOOLSETS["workflows"]["tools"]

    def test_in_the_core_bundle_but_check_fn_gated(self):
        # It must be in the core bundle to reach every platform, and it must
        # stay check_fn-gated so `enabled: false` still removes the schema.
        from toolsets import _HERMES_CORE_TOOLS
        from tools.registry import registry

        assert "workflow" in _HERMES_CORE_TOOLS
        assert registry._tools["workflow"].check_fn is not None


class TestWorkflowToolActions:
    def _call(self, **kwargs):
        from tools.workflow_tool import workflow

        with patch(
            "tools.workflow_tool._load_config",
            return_value={"enabled": True, "max_agents": 10, "max_concurrency": 2},
        ):
            return json.loads(workflow(parent_agent=None, **kwargs))

    def test_start_requires_a_script(self):
        assert "error" in self._call(action="start")

    def test_status_requires_a_run_id(self):
        assert "error" in self._call(action="status")

    def test_unknown_action_is_reported(self):
        assert "unknown action" in self._call(action="frobnicate")["error"]

    def test_unknown_run_id_is_reported(self):
        assert "error" in self._call(action="status", run_id="wf_nope")

    def test_start_then_wait_returns_the_result_inline(self):
        from tools.workflow_tool import workflow

        real_start = manager.start_workflow

        def _fake_start(source, **kwargs):
            kwargs["agent_runner"] = lambda p, **kk: _ok("done")
            return real_start(source, **kwargs)

        with (
            patch(
                "tools.workflow_tool._load_config",
                return_value={"enabled": True, "max_agents": 5, "max_concurrency": 2},
            ),
            patch("agent.workflow_manager.start_workflow", side_effect=_fake_start),
        ):
            payload = json.loads(
                workflow(
                    action="start",
                    script='return await agent("x")',
                    wait_seconds=10,
                    parent_agent=None,
                )
            )
        assert payload.get("result") == "done"

    def test_list_returns_runs(self):
        _start('return await agent("x")').wait(10)
        payload = self._call(action="list")
        assert isinstance(payload["runs"], list)


class TestOwnerDepth:
    def test_missing_depth_is_treated_as_top_level(self):
        from tools.workflow_tool import _owner_depth

        assert _owner_depth(None) == 0

    def test_subagent_depth_is_carried_through(self):
        from tools.workflow_tool import _owner_depth

        class _Agent:
            _delegate_depth = 2

        assert _owner_depth(_Agent()) == 2

    def test_bogus_depth_falls_back_to_zero(self):
        from tools.workflow_tool import _owner_depth

        class _Agent:
            _delegate_depth = "deep"

        assert _owner_depth(_Agent()) == 0
