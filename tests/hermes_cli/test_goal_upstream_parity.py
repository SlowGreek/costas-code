"""Upstream parity for goal controls while preserving cross-driver wake support."""

from __future__ import annotations

import inspect
import json
import logging
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


def test_goal_manager_has_no_fork_only_durable_steer_api(hermes_home):
    from hermes_cli.goals import GoalManager

    manager = GoalManager(session_id="upstream-parity")
    assert not hasattr(manager, "add_steer")
    assert not hasattr(manager, "clear_steers")
    assert not hasattr(manager, "render_steers")


def test_cli_does_not_dispatch_fork_only_goal_steer(hermes_home):
    from hermes_cli.cli_commands_mixin import CLICommandsMixin

    source = inspect.getsource(CLICommandsMixin._handle_goal_command)
    assert "add_steer" not in source
    assert "clear_steers" not in source


def test_gateway_does_not_dispatch_fork_only_goal_steer(hermes_home):
    import tui_gateway.methods_tools as methods_tools

    source = inspect.getsource(methods_tools)
    assert "add_steer" not in source
    assert "clear_steers" not in source


def test_legacy_goal_steers_are_explicitly_discarded(hermes_home, caplog):
    from hermes_cli.goals import GoalState

    raw = json.dumps(
        {
            "goal": "ship it",
            "status": "active",
            "steers": ["legacy correction"],
        }
    )
    with caplog.at_level(logging.WARNING, logger="hermes_cli.goals"):
        state = GoalState.from_json(raw)

    assert state.goal == "ship it"
    assert "discarded 1 legacy /goal steer" in caplog.text


def test_both_drivers_still_wire_goal_wake(hermes_home):
    import cli
    import tui_gateway.server as server

    gateway_source = inspect.getsource(server._maybe_wake_parked_goal)
    cli_source = inspect.getsource(cli.HermesCLI._maybe_wake_parked_goal)
    assert "poll_wake" in gateway_source
    assert "poll_wake" in cli_source
