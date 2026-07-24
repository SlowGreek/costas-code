"""Tests for agent.workflow_agent.

Focus is the safety contract the design review flagged: depth must be explicit
and fail CLOSED, because ``_build_child_agent`` derives depth with
``getattr(parent, "_delegate_depth", 0)`` which silently resets to top level for
any non-AIAgent owner — and a workflow runtime is exactly that.

Children are faked so these exercise the real orchestration logic (retry
policy, depth math, failure classification) without spawning agents.
"""

from unittest.mock import patch

import pytest

from agent.workflow_agent import (
    AgentOutcome,
    WorkflowAgentError,
    WorkflowDepthError,
    build_agent_goal,
    check_depth_allowed,
    resolve_child_depth,
    run_workflow_agent,
)


SCHEMA = {
    "type": "object",
    "required": ["verdict"],
    "properties": {"verdict": {"type": "string", "enum": ["confirmed", "refuted"]}},
}


class TestResolveChildDepth:
    def test_top_level_owner_produces_depth_one(self):
        assert resolve_child_depth(0) == 1

    def test_subagent_owner_increments(self):
        assert resolve_child_depth(1) == 2

    def test_missing_depth_fails_closed(self):
        # The whole point: never silently assume top level.
        with pytest.raises(WorkflowDepthError):
            resolve_child_depth(None)

    def test_non_integer_depth_fails_closed(self):
        with pytest.raises(WorkflowDepthError):
            resolve_child_depth("0")
        with pytest.raises(WorkflowDepthError):
            resolve_child_depth(1.5)

    def test_bool_is_not_an_acceptable_depth(self):
        # bool is an int subclass; True would quietly mean depth 1.
        with pytest.raises(WorkflowDepthError):
            resolve_child_depth(True)

    def test_negative_depth_rejected(self):
        with pytest.raises(WorkflowDepthError):
            resolve_child_depth(-1)


class TestCheckDepthAllowed:
    def test_within_cap_is_allowed(self):
        check_depth_allowed(1, 1)

    def test_beyond_cap_is_rejected(self):
        # A workflow started BY a subagent must not fan out under a flat cap.
        with pytest.raises(WorkflowDepthError) as excinfo:
            check_depth_allowed(2, 1)
        assert "max_spawn_depth" in str(excinfo.value)


class TestBuildAgentGoal:
    def test_schema_instruction_is_appended(self):
        goal = build_agent_goal("Audit a.py", SCHEMA, None)
        assert "Audit a.py" in goal
        assert "verdict" in goal

    def test_context_is_included(self):
        goal = build_agent_goal("Audit", None, "repo is read-only")
        assert "read-only" in goal

    def test_bare_prompt_without_schema_is_unchanged(self):
        assert build_agent_goal("Just do it", None, None) == "Just do it"


def _fake_child_runner(results):
    """Return a _run_single_child stub yielding queued results in order."""
    queue = list(results)

    def _run(**_kwargs):
        return queue.pop(0)

    return _run


def _completed(summary, api_calls=1):
    return {"status": "completed", "summary": summary, "api_calls": api_calls, "duration": 0.1}


class TestRunWorkflowAgent:
    def _run(self, results, **kwargs):
        with (
            patch("tools.delegate_tool._build_child_agent", return_value=object()),
            patch("tools.delegate_tool._get_max_spawn_depth", return_value=3),
            patch("tools.delegate_tool._run_single_child", side_effect=_fake_child_runner(results)),
        ):
            return run_workflow_agent(
                "Verify the finding",
                owner_agent=object(),
                owner_depth=kwargs.pop("owner_depth", 0),
                **kwargs,
            )

    def test_valid_json_is_returned_parsed(self):
        outcome = self._run([_completed('{"verdict": "confirmed"}')], schema=SCHEMA)
        assert outcome.ok
        assert outcome.value == {"verdict": "confirmed"}
        assert outcome.attempts == 1

    def test_narrated_json_still_parses(self):
        outcome = self._run(
            [_completed('I checked it.\n```json\n{"verdict": "refuted"}\n```')],
            schema=SCHEMA,
        )
        assert outcome.ok
        assert outcome.value["verdict"] == "refuted"

    def test_unparseable_output_is_retried_then_reported(self):
        outcome = self._run(
            [_completed("no idea"), _completed("still no idea")],
            schema=SCHEMA,
            max_attempts=2,
        )
        assert not outcome.ok
        assert outcome.status == "invalid_output"
        assert outcome.attempts == 2

    def test_retry_recovers_a_correctable_answer(self):
        outcome = self._run(
            [_completed("sorry, prose"), _completed('{"verdict": "confirmed"}')],
            schema=SCHEMA,
            max_attempts=2,
        )
        assert outcome.ok
        assert outcome.attempts == 2

    def test_failed_child_is_not_retried(self):
        # Re-running a crashed agent rarely helps and costs a full run, so the
        # queue must not be drained past the first failure.
        outcome = self._run(
            [{"status": "failed", "summary": "", "api_calls": 1, "duration": 0.1}],
            schema=SCHEMA,
            max_attempts=3,
        )
        assert not outcome.ok
        assert outcome.status == "failed"
        assert outcome.attempts == 1

    def test_interrupted_child_is_surfaced_not_retried(self):
        outcome = self._run(
            [{"status": "interrupted", "summary": "", "api_calls": 0, "duration": 0.0}],
            schema=SCHEMA,
        )
        assert outcome.status == "interrupted"
        assert not outcome.ok

    def test_no_schema_returns_the_prose_summary(self):
        outcome = self._run([_completed("here is my analysis")])
        assert outcome.ok
        assert outcome.value == "here is my analysis"

    def test_api_calls_accumulate_across_retries(self):
        outcome = self._run(
            [_completed("bad", api_calls=3), _completed('{"verdict": "confirmed"}', api_calls=2)],
            schema=SCHEMA,
            max_attempts=2,
        )
        assert outcome.api_calls == 5

    def test_label_rides_through_to_the_outcome(self):
        outcome = self._run([_completed('{"verdict": "confirmed"}')], schema=SCHEMA, label="a.py")
        assert outcome.label == "a.py"

    def test_depth_cap_is_enforced_before_any_child_is_built(self):
        with (
            patch("tools.delegate_tool._build_child_agent") as build,
            patch("tools.delegate_tool._get_max_spawn_depth", return_value=1),
            patch("tools.delegate_tool._run_single_child") as run,
        ):
            with pytest.raises(WorkflowDepthError):
                run_workflow_agent(
                    "go", owner_agent=object(), owner_depth=1, schema=SCHEMA
                )
            build.assert_not_called()
            run.assert_not_called()

    def test_empty_prompt_is_rejected(self):
        with pytest.raises(WorkflowAgentError):
            run_workflow_agent("   ", owner_agent=object(), owner_depth=0)


class TestAgentOutcomeSerialization:
    def test_failure_omits_value_and_truncates_summary(self):
        payload = AgentOutcome(
            ok=False, error="boom", summary="z" * 5000, status="invalid_output"
        ).to_dict()
        assert "value" not in payload
        assert payload["error"] == "boom"
        assert len(payload["summary"]) <= 2000

    def test_success_carries_the_value(self):
        payload = AgentOutcome(ok=True, value={"verdict": "confirmed"}, label="x").to_dict()
        assert payload["value"] == {"verdict": "confirmed"}
        assert payload["label"] == "x"
