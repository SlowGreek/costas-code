"""Tests for the dynamic workflow runtime.

These exercise the contract that makes workflows worth having: the SCRIPT holds
the plan, results stay in script variables, fan-out is bounded and concurrent,
and one bad agent cannot take down a 50-item run.

Agents are faked, so these test orchestration behaviour rather than model
output. The budget/limit tests are the load-bearing ones — a runaway loop in a
model-written script is a runaway bill.
"""

import time
from unittest.mock import patch

import pytest

from agent.workflow_agent import AgentOutcome
from agent.workflow_runtime import (
    DEFAULT_MAX_AGENTS,
    DEFAULT_MAX_CONCURRENCY,
    HARD_MAX_AGENTS,
    WorkflowLimits,
    WorkflowRuntime,
    WorkflowScriptError,
    extract_meta,
    validate_script,
)


def _ok(value, api_calls=1):
    return AgentOutcome(ok=True, value=value, api_calls=api_calls)


def _fail(error="boom"):
    return AgentOutcome(ok=False, error=error, status="invalid_output")


def _runtime(runner, **kwargs):
    return WorkflowRuntime(
        owner_agent=object(),
        owner_depth=kwargs.pop("owner_depth", 0),
        agent_runner=runner,
        **kwargs,
    )


class TestValidateScript:
    def test_plain_script_is_accepted(self):
        validate_script("x = 1\nreturn x")

    def test_empty_script_rejected(self):
        with pytest.raises(WorkflowScriptError):
            validate_script("   ")

    def test_syntax_error_is_reported_clearly(self):
        with pytest.raises(WorkflowScriptError) as excinfo:
            validate_script("def (:")
        assert "syntax error" in str(excinfo.value)

    @pytest.mark.parametrize(
        "source",
        [
            "import os",
            "from os import path",
            "__import__('os')",
            "eval('1')",
            "exec('x=1')",
            "open('/etc/passwd')",
            "getattr(x, 'y')",
        ],
    )
    def test_forbidden_constructs_are_rejected(self, source):
        with pytest.raises(WorkflowScriptError):
            validate_script(source)

    def test_dunder_attribute_access_is_rejected(self):
        # The standard route out of a stripped namespace.
        with pytest.raises(WorkflowScriptError):
            validate_script("().__class__.__bases__[0]")

    def test_error_message_names_the_line(self):
        with pytest.raises(WorkflowScriptError) as excinfo:
            validate_script("x = 1\nimport os\n")
        assert "line 2" in str(excinfo.value)


class TestExtractMeta:
    def test_reads_meta_without_executing(self):
        meta = extract_meta("meta = {'name': 'audit', 'description': 'd'}\nx = 1")
        assert meta["name"] == "audit"

    def test_missing_meta_is_empty(self):
        assert extract_meta("x = 1") == {}

    def test_non_literal_meta_is_ignored(self):
        assert extract_meta("meta = compute()") == {}

    def test_broken_script_does_not_raise(self):
        assert extract_meta("def (:") == {}


class TestWorkflowLimits:
    def test_defaults(self):
        limits = WorkflowLimits.from_config({})
        assert limits.max_agents == DEFAULT_MAX_AGENTS
        assert limits.max_concurrency == DEFAULT_MAX_CONCURRENCY

    def test_hard_ceiling_applies(self):
        assert WorkflowLimits.from_config({"max_agents": 99999}).max_agents == HARD_MAX_AGENTS

    def test_floor_of_one(self):
        assert WorkflowLimits.from_config({"max_agents": 0}).max_agents == 1

    def test_garbage_falls_back_to_default(self):
        assert WorkflowLimits.from_config({"max_agents": "lots"}).max_agents == DEFAULT_MAX_AGENTS


class TestAgentPrimitive:
    def test_returns_validated_value_to_the_script(self):
        rt = _runtime(lambda *a, **k: _ok({"verdict": "confirmed"}))
        result = rt.run('v = await agent("check")\nreturn v["verdict"]')
        assert result.ok
        assert result.value == "confirmed"

    def test_bare_agent_failure_fails_the_run_loudly(self):
        # A single load-bearing step must not silently yield None.
        rt = _runtime(lambda *a, **k: _fail("no json"))
        result = rt.run('return await agent("check")')
        assert not result.ok
        assert "no json" in result.error

    def test_optional_agent_failure_returns_none(self):
        rt = _runtime(lambda *a, **k: _fail())
        result = rt.run('v = await agent("check", optional=True)\nreturn v is None')
        assert result.ok
        assert result.value is True

    def test_api_calls_are_accumulated(self):
        rt = _runtime(lambda *a, **k: _ok("x", api_calls=3))
        result = rt.run('await agent("a")\nawait agent("b")\nreturn 1')
        assert result.api_calls == 6
        assert result.agents_run == 2


class TestPipelinePrimitive:
    def test_maps_over_items_preserving_order(self):
        rt = _runtime(lambda prompt, **k: _ok(prompt))
        result = rt.run(
            'out = await pipeline(["a", "b", "c"], lambda f: agent(f))\nreturn out'
        )
        assert result.ok
        assert result.value == ["a", "b", "c"]

    def test_failed_item_becomes_none_and_run_survives(self):
        # The .filter(Boolean) shape workflows are written around.
        def runner(prompt, **_kwargs):
            return _fail() if prompt == "b" else _ok(prompt)

        rt = _runtime(runner)
        result = rt.run(
            'out = await pipeline(["a", "b", "c"], lambda f: agent(f))\n'
            "return [x for x in out if x]"
        )
        assert result.ok
        assert result.value == ["a", "c"]

    def test_failures_are_recorded_for_inspection(self):
        rt = _runtime(lambda *a, **k: _fail("bad output"))
        result = rt.run('return await pipeline(["a", "b"], lambda f: agent(f))')
        assert result.ok
        assert len(result.failures) == 2

    def test_callback_may_take_an_index(self):
        rt = _runtime(lambda prompt, **k: _ok(prompt))
        result = rt.run(
            'return await pipeline(["a", "b"], lambda f, i: agent(f"{i}:{f}"))'
        )
        assert result.value == ["0:a", "1:b"]

    def test_empty_list_short_circuits(self):
        rt = _runtime(lambda *a, **k: _ok("x"))
        result = rt.run("return await pipeline([], lambda f: agent(f))")
        assert result.value == []
        assert result.agents_run == 0

    def test_non_list_is_a_script_error(self):
        rt = _runtime(lambda *a, **k: _ok("x"))
        result = rt.run('return await pipeline("abc", lambda f: agent(f))')
        assert not result.ok
        assert "requires a list" in result.error

    def test_concurrency_is_bounded(self):
        active = {"now": 0, "peak": 0}

        def runner(prompt, **_kwargs):
            active["now"] += 1
            active["peak"] = max(active["peak"], active["now"])
            time.sleep(0.02)
            active["now"] -= 1
            return _ok(prompt)

        rt = _runtime(runner, limits=WorkflowLimits(max_agents=20, max_concurrency=3))
        result = rt.run(
            'return await pipeline([str(i) for i in range(12)], lambda f: agent(f))'
        )
        assert result.ok
        assert active["peak"] <= 3

    def test_fan_out_actually_runs_concurrently(self):
        def runner(prompt, **_kwargs):
            time.sleep(0.05)
            return _ok(prompt)

        rt = _runtime(runner, limits=WorkflowLimits(max_agents=20, max_concurrency=8))
        started = time.monotonic()
        result = rt.run('return await pipeline([str(i) for i in range(8)], lambda f: agent(f))')
        elapsed = time.monotonic() - started

        assert result.ok
        # 8 x 50ms serially would be 400ms; concurrent should be far below.
        assert elapsed < 0.30


class TestBudgetEnforcement:
    def test_agent_cap_stops_a_runaway_loop(self):
        rt = _runtime(lambda *a, **k: _ok("x"), limits=WorkflowLimits(max_agents=5))
        result = rt.run(
            "out = []\n"
            "while True:\n"
            '    out.append(await agent("go"))\n'
            "return out"
        )
        assert not result.ok
        assert "agent limit" in result.error
        assert result.agents_run == 5

    def test_cap_is_claimed_before_spawning(self):
        calls = {"n": 0}

        def runner(*_args, **_kwargs):
            calls["n"] += 1
            return _ok("x")

        rt = _runtime(runner, limits=WorkflowLimits(max_agents=3))
        rt.run('return await pipeline(["a","b","c","d","e"], lambda f: agent(f))')
        # Never spawns past the ceiling, even under concurrency.
        assert calls["n"] <= 3

    def test_stop_prevents_further_agents(self):
        rt = _runtime(lambda *a, **k: _ok("x"))
        rt.stop()
        result = rt.run('return await agent("go")')
        assert not result.ok
        assert "stopped" in result.error


class TestScriptExecution:
    def test_args_are_exposed_to_the_script(self):
        rt = _runtime(lambda *a, **k: _ok("x"), args={"repo": "/tmp/x"})
        result = rt.run('return args["repo"]')
        assert result.value == "/tmp/x"

    def test_json_and_re_are_available_for_data_work(self):
        rt = _runtime(lambda *a, **k: _ok("x"))
        result = rt.run('return json.dumps({"a": 1}) + re.sub("x", "y", "x")')
        assert result.value == '{"a": 1}y'

    def test_script_runtime_error_is_reported_not_raised(self):
        rt = _runtime(lambda *a, **k: _ok("x"))
        result = rt.run("return 1 / 0")
        assert not result.ok
        assert "ZeroDivisionError" in result.error

    def test_forbidden_import_is_caught_before_execution(self):
        ran = {"n": 0}

        def runner(*_a, **_k):
            ran["n"] += 1
            return _ok("x")

        rt = _runtime(runner)
        result = rt.run('import os\nreturn await agent("go")')
        assert not result.ok
        assert ran["n"] == 0

    def test_events_are_emitted_for_observability(self):
        events = []
        rt = _runtime(lambda *a, **k: _ok("x"), on_event=events.append)
        rt.run('return await agent("go", label="one")')

        kinds = [e["type"] for e in events]
        assert "agent_start" in kinds and "agent_end" in kinds
        assert any(e.get("label") == "one" for e in events)

    def test_observer_exception_does_not_break_the_run(self):
        def bad_observer(_event):
            raise RuntimeError("observer boom")

        rt = _runtime(lambda *a, **k: _ok("x"), on_event=bad_observer)
        assert rt.run('return await agent("go")').ok


class TestAdversarialVerificationShape:
    def test_fan_out_then_verify_then_filter(self):
        """The end-to-end pattern the feature exists for.

        Fan out audits, have a second agent grade each finding, and return only
        the confirmed ones — with every intermediate result living in script
        variables rather than the model's context.
        """

        def runner(prompt, **_kwargs):
            if prompt.startswith("Audit"):
                target = prompt.split()[1]
                return _ok({"file": target, "severity": "high" if target != "b.py" else "low"})
            if prompt.startswith("Verify"):
                return _ok({"verdict": "confirmed" if "a.py" in prompt else "refuted"})
            return _ok(None)

        rt = _runtime(runner, limits=WorkflowLimits(max_agents=20, max_concurrency=4))
        result = rt.run(
            'audits = await pipeline(["a.py", "b.py", "c.py"], lambda f: agent(f"Audit {f} now"))\n'
            'high = [a for a in audits if a and a["severity"] == "high"]\n'
            'checked = await pipeline(high, lambda a: agent(f"Verify {a[\'file\']}"))\n'
            'return [h["file"] for h, v in zip(high, checked) if v and v["verdict"] == "confirmed"]'
        )

        assert result.ok
        assert result.value == ["a.py"]
        assert result.agents_run == 5
