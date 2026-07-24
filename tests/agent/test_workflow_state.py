"""Tests for workflow run state and safe resume.

The load-bearing tests here are the divergence ones. Naive positional replay
silently hands a previous run's results to *different* calls when the script
takes another path, producing a confidently wrong final answer with no error.
These assert that replay stops the moment the call sequence stops matching.
"""

import json

import pytest

from agent.workflow_agent import AgentOutcome
from agent.workflow_runtime import WorkflowLimits, WorkflowRuntime
from agent.workflow_state import (
    AgentRecord,
    ReplayLog,
    WorkflowState,
    WorkflowStore,
    call_signature,
    new_run_id,
    workspace_fingerprint,
)


class TestCallSignature:
    def test_same_call_hashes_the_same(self):
        assert call_signature("audit a.py", {"type": "object"}) == call_signature(
            "audit a.py", {"type": "object"}
        )

    def test_prompt_change_changes_the_hash(self):
        assert call_signature("audit a.py") != call_signature("audit b.py")

    def test_schema_change_changes_the_hash(self):
        assert call_signature("go", {"type": "object"}) != call_signature("go", {"type": "array"})

    def test_label_is_cosmetic_and_ignored(self):
        # Relabelling shouldn't throw away a paid result.
        assert call_signature("go", None, {"label": "x"}) == call_signature(
            "go", None, {"label": "y"}
        )

    def test_model_choice_is_part_of_identity(self):
        assert call_signature("go", None, {"model": "a"}) != call_signature(
            "go", None, {"model": "b"}
        )

    def test_absent_and_none_options_agree(self):
        assert call_signature("go", None, {"model": None}) == call_signature("go", None, {})


class TestReplayLog:
    def _records(self):
        return [
            AgentRecord(index=0, signature=call_signature("a"), ok=True, value="A"),
            AgentRecord(index=1, signature=call_signature("b"), ok=True, value="B"),
        ]

    def test_matching_sequence_replays_in_order(self):
        log = ReplayLog(self._records())
        assert log.next_result(call_signature("a")).value == "A"
        assert log.next_result(call_signature("b")).value == "B"
        assert log.replayed == 2

    def test_divergence_stops_replay_permanently(self):
        # The dangerous case: the script branches differently on resume.
        log = ReplayLog(self._records())
        assert log.next_result(call_signature("a")).value == "A"

        # Call 2 is now a different call than recorded.
        assert log.next_result(call_signature("DIFFERENT")) is None
        assert log.diverged_at == 1
        assert not log.active

        # Even a call that WOULD have matched is no longer replayed — the
        # recording can no longer be trusted to line up.
        assert log.next_result(call_signature("b")) is None

    def test_running_past_the_recording_disables_replay(self):
        log = ReplayLog(self._records())
        log.next_result(call_signature("a"))
        log.next_result(call_signature("b"))
        assert log.next_result(call_signature("c")) is None
        assert not log.active

    def test_no_previous_run_means_no_replay(self):
        log = ReplayLog([])
        assert not log.active
        assert log.next_result(call_signature("a")) is None

    def test_failed_records_are_replayed_as_failures(self):
        log = ReplayLog([AgentRecord(index=0, signature=call_signature("a"), ok=False, error="bad")])
        record = log.next_result(call_signature("a"))
        assert record is not None and not record.ok


class TestWorkflowStore:
    def test_round_trips_state(self, tmp_path):
        store = WorkflowStore("wf_test", base_dir=tmp_path / "wf_test")
        state = WorkflowState(run_id="wf_test", meta={"name": "audit"})
        state.agents.append(AgentRecord(index=0, signature="sig", ok=True, value={"a": 1}))
        store.save(state)

        loaded = store.load()
        assert loaded.run_id == "wf_test"
        assert loaded.meta["name"] == "audit"
        assert loaded.agents[0].value == {"a": 1}

    def test_missing_state_returns_none(self, tmp_path):
        assert WorkflowStore("nope", base_dir=tmp_path / "nope").load() is None

    def test_corrupt_state_returns_none_instead_of_raising(self, tmp_path):
        run = tmp_path / "wf_bad"
        run.mkdir()
        (run / "state.json").write_text("{not json", encoding="utf-8")
        assert WorkflowStore("wf_bad", base_dir=run).load() is None

    def test_save_is_atomic(self, tmp_path):
        # A truncated state.json would lose exactly the results this exists to
        # protect, so writes must land whole or not at all.
        run = tmp_path / "wf_atomic"
        store = WorkflowStore("wf_atomic", base_dir=run)
        store.save(WorkflowState(run_id="wf_atomic"))

        for i in range(5):
            state = store.load()
            state.agents.append(AgentRecord(index=i, signature=f"s{i}", ok=True))
            store.save(state)
            json.loads((run / "state.json").read_text(encoding="utf-8"))

        assert len(store.load().agents) == 5
        assert not list(run.glob(".state-*"))

    def test_script_round_trips(self, tmp_path):
        store = WorkflowStore("wf_s", base_dir=tmp_path / "wf_s")
        store.write_script("return 1")
        assert store.read_script() == "return 1"

    def test_api_calls_are_summed(self):
        state = WorkflowState(run_id="x")
        state.agents = [
            AgentRecord(index=0, signature="a", ok=True, api_calls=3),
            AgentRecord(index=1, signature="b", ok=True, api_calls=4),
        ]
        assert state.api_calls == 7


class TestRunIds:
    def test_run_ids_are_unique_and_prefixed(self):
        ids = {new_run_id() for _ in range(20)}
        assert len(ids) == 20
        assert all(i.startswith("wf_") for i in ids)


class TestWorkspaceFingerprint:
    def test_none_for_missing_paths(self):
        assert workspace_fingerprint(None) is None
        assert workspace_fingerprint("/nonexistent/path/xyz") is None

    def test_changes_when_a_file_is_added(self, tmp_path):
        (tmp_path / "a.txt").write_text("a")
        before = workspace_fingerprint(str(tmp_path))
        (tmp_path / "b.txt").write_text("b")
        assert workspace_fingerprint(str(tmp_path)) != before


def _ok(value):
    return AgentOutcome(ok=True, value=value, api_calls=1)


class TestRuntimeReplayIntegration:
    """End-to-end: a resumed run must not re-pay for finished agents, and must
    not hand stale results to a script that changed its mind."""

    def _runtime(self, runner, replay=None, records=None):
        return WorkflowRuntime(
            owner_agent=object(),
            owner_depth=0,
            agent_runner=runner,
            replay=replay,
            on_agent_record=(records.append if records is not None else None),
            limits=WorkflowLimits(max_agents=20, max_concurrency=4),
        )

    def test_replayed_agents_are_not_re_run(self):
        calls = {"n": 0}

        def runner(prompt, **_kwargs):
            calls["n"] += 1
            return _ok(prompt)

        records = []
        first = self._runtime(runner, records=records)
        first_result = first.run('return await pipeline(["a", "b"], lambda f: agent(f))')
        assert first_result.value == ["a", "b"]
        assert calls["n"] == 2

        # Resume with the same script: everything replays, nothing is re-run.
        calls["n"] = 0
        replayed = self._runtime(runner, replay=ReplayLog(sorted(records, key=lambda r: r.index)))
        second = replayed.run('return await pipeline(["a", "b"], lambda f: agent(f))')

        assert second.value == ["a", "b"]
        assert calls["n"] == 0
        assert replayed.replayed_agents == 2

    def test_changed_script_diverges_and_re_runs_the_remainder(self):
        records = []
        runner = lambda prompt, **_k: _ok(prompt)  # noqa: E731

        first = self._runtime(runner, records=records)
        first.run('return await pipeline(["a", "b"], lambda f: agent(f))')

        calls = {"n": 0}

        def counting_runner(prompt, **_kwargs):
            calls["n"] += 1
            return _ok(prompt.upper())

        # Second element changed: call 1 replays, call 2 diverges and runs.
        resumed = self._runtime(
            counting_runner, replay=ReplayLog(sorted(records, key=lambda r: r.index))
        )
        result = resumed.run('return await pipeline(["a", "z"], lambda f: agent(f))')

        assert result.value == ["a", "Z"]
        assert calls["n"] == 1
        assert resumed.diverged_at == 1

    def test_records_capture_enough_to_resume(self):
        records = []
        rt = self._runtime(lambda p, **k: _ok(p), records=records)
        rt.run('return await agent("go", label="one")')

        assert len(records) == 1
        assert records[0].ok and records[0].label == "one"
        assert records[0].signature == call_signature("go", None, {})

    def test_replay_does_not_consume_the_agent_budget(self):
        records = []
        first = self._runtime(lambda p, **k: _ok(p), records=records)
        first.run('return await pipeline(["a", "b", "c"], lambda f: agent(f))')

        resumed = WorkflowRuntime(
            owner_agent=object(),
            owner_depth=0,
            agent_runner=lambda p, **k: _ok(p),
            replay=ReplayLog(sorted(records, key=lambda r: r.index)),
            limits=WorkflowLimits(max_agents=1, max_concurrency=1),
        )
        # All three replay despite a budget of one live agent.
        result = resumed.run('return await pipeline(["a", "b", "c"], lambda f: agent(f))')
        assert result.ok
        assert result.value == ["a", "b", "c"]
