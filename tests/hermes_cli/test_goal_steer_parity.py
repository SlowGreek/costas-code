"""Driver parity for the /goal lifecycle.

The bug this guards against: a goal capability wired into ONE driver.
``poll_wake()`` shipped with only a ``cli.py`` caller, so the desktop
gateway could park a goal and never unpark it. ``/goal steer`` is the
same shape of feature, so both drivers are asserted together here.

These tests exercise the shared ``GoalManager`` surface plus a source-level
check that each driver actually dispatches the verb — a unit test of
``add_steer`` alone would have passed happily while the desktop dropped
the command on the floor, which is precisely how the wake bug survived.
"""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest


@pytest.fixture()
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))

    from hermes_cli import goals

    goals._DB_CACHE.clear()
    yield home
    goals._DB_CACHE.clear()


class TestSteerPersistence:
    def test_steer_survives_a_reload(self, hermes_home):
        from hermes_cli.goals import GoalManager

        mgr = GoalManager(session_id="steer-1")
        mgr.set("build the parser")
        mgr.add_steer("use the existing tokenizer")

        # A fresh manager is what every continuation cycle constructs.
        reloaded = GoalManager(session_id="steer-1")
        assert "use the existing tokenizer" in reloaded.next_continuation_prompt()

    def test_no_steer_leaves_the_prompt_byte_identical(self, hermes_home):
        """Steering is additive — the no-steer path must not drift."""
        from hermes_cli.goals import CONTINUATION_PROMPT_TEMPLATE, GoalManager

        mgr = GoalManager(session_id="steer-2")
        mgr.set("do the thing")
        assert mgr.next_continuation_prompt() == (
            CONTINUATION_PROMPT_TEMPLATE.format(goal="do the thing")
        )

    def test_steers_render_in_send_order(self, hermes_home):
        from hermes_cli.goals import GoalManager

        mgr = GoalManager(session_id="steer-3")
        mgr.set("ship")
        mgr.add_steer("first correction")
        mgr.add_steer("second correction")
        prompt = mgr.next_continuation_prompt()
        assert prompt.index("first correction") < prompt.index("second correction")

    def test_steer_rejects_empty_text(self, hermes_home):
        from hermes_cli.goals import GoalManager

        mgr = GoalManager(session_id="steer-4")
        mgr.set("g")
        with pytest.raises(ValueError):
            mgr.add_steer("   ")

    def test_steer_requires_a_goal(self, hermes_home):
        from hermes_cli.goals import GoalManager

        with pytest.raises(RuntimeError):
            GoalManager(session_id="steer-5").add_steer("nope")

    def test_old_state_rows_load_without_steers(self, hermes_home):
        """Backwards compatibility: pre-steer rows must still deserialize."""
        from hermes_cli.goals import GoalState

        state = GoalState.from_json(
            '{"goal": "legacy", "status": "active", "turns_used": 1, '
            '"max_turns": 20, "created_at": 1.0, "last_turn_at": 2.0}'
        )
        assert state.steers == []

    def test_steers_round_trip_through_json(self, hermes_home):
        from hermes_cli.goals import GoalState

        original = GoalState(
            goal="g", status="active", turns_used=0, max_turns=20,
            created_at=1.0, last_turn_at=0.0, steers=["keep it simple"],
        )
        assert GoalState.from_json(original.to_json()).steers == ["keep it simple"]


class TestSteersReachEveryConsumer:
    """A steer must shape every path that reads the goal, not just the
    happy-path continuation prompt."""

    def test_gate_failure_continuation_carries_steers(self, hermes_home):
        from hermes_cli.goals import GoalManager

        mgr = GoalManager(session_id="steer-gate")
        mgr.set("make it green")
        mgr.add_gate("false")  # always fails
        mgr.add_steer("do not edit the CI config")

        decision = mgr._check_gates()
        assert decision is not None
        assert decision["should_continue"] is True
        assert "do not edit the CI config" in decision["continuation_prompt"]

    def test_judge_sees_the_steered_goal(self, hermes_home, monkeypatch):
        """Otherwise the agent follows the steer while the judge grades the
        original wording."""
        import hermes_cli.goals as goals

        seen = {}

        def fake_judge(goal, last_response, **kw):
            seen["goal"] = goal
            return "continue", "keep going", False, None, False

        monkeypatch.setattr(goals, "judge_goal", fake_judge)

        mgr = goals.GoalManager(session_id="steer-judge")
        mgr.set("rewrite the parser")
        mgr.add_steer("keep the public API stable")
        mgr.evaluate_after_turn("did some work")

        assert "keep the public API stable" in seen["goal"]
        assert "rewrite the parser" in seen["goal"]

    def test_verifier_sees_the_steered_goal(self, hermes_home, monkeypatch):
        import hermes_cli.goals as goals

        seen = {}

        def fake_judge(goal, last_response, **kw):
            return "done", "looks complete", False, None, False

        def fake_verify(goal, last_response, **kw):
            seen["goal"] = goal
            return True, "corroborated", False

        monkeypatch.setattr(goals, "judge_goal", fake_judge)
        monkeypatch.setattr(goals, "verify_completion", fake_verify)

        mgr = goals.GoalManager(session_id="steer-verify")
        mgr.set("ship the feature")
        mgr.add_steer("tests must run offline")
        mgr.evaluate_after_turn("all done")

        assert "tests must run offline" in seen["goal"]

    def test_unsteered_judge_input_is_the_bare_goal(self, hermes_home, monkeypatch):
        """No steers → byte-identical to the previous behaviour."""
        import hermes_cli.goals as goals

        seen = {}

        def fake_judge(goal, last_response, **kw):
            seen["goal"] = goal
            return "continue", "more work", False, None, False

        monkeypatch.setattr(goals, "judge_goal", fake_judge)

        mgr = goals.GoalManager(session_id="steer-none")
        mgr.set("plain objective")
        mgr.evaluate_after_turn("worked")

        assert seen["goal"] == "plain objective"


class TestDriverParity:
    """Both drivers must dispatch the verb, not just the model support it."""

    def test_cli_dispatches_goal_steer(self, hermes_home):
        from hermes_cli.cli_commands_mixin import CLICommandsMixin

        src = inspect.getsource(CLICommandsMixin._handle_goal_command)
        assert "steer" in src
        assert "add_steer" in src

    def test_gateway_dispatches_goal_steer(self, hermes_home):
        import tui_gateway.methods_tools as mt

        src = inspect.getsource(mt)
        assert "add_steer" in src

    def test_both_drivers_wire_poll_wake(self, hermes_home):
        """The original defect: only one driver called poll_wake()."""
        import tui_gateway.server as server
        from hermes_cli.cli_commands_mixin import CLICommandsMixin  # noqa: F401

        gateway_src = inspect.getsource(server._maybe_wake_parked_goal)
        assert "poll_wake" in gateway_src

        import cli

        cli_src = inspect.getsource(cli.HermesCLI._maybe_wake_parked_goal)
        assert "poll_wake" in cli_src
