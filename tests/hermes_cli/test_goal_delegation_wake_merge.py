"""Upstream delegation parking and Catalyst wake controls share one state."""
from hermes_cli import goals


def test_delegation_result_releases_restored_goal_wait(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    goals._DB_CACHE.clear()
    try:
        mgr = goals.GoalManager("delegation-wake")
        mgr.set("finish after the review")
        monkeypatch.setattr(goals, "judge_goal", lambda *a, **k: (
            "wait", "review still running", False, {"seconds": 600}, False,
        ))
        decision = mgr.evaluate_after_turn("waiting for review", active_delegations=2)
        assert not decision["should_continue"]
        restored = goals.GoalManager("delegation-wake")
        monkeypatch.setattr(goals, "count_active_delegations", lambda sid: 2)
        assert restored.poll_wake() is None
        monkeypatch.setattr(goals, "count_active_delegations", lambda sid: 1)
        assert "finish after the review" in (restored.poll_wake() or "")
        assert restored.poll_wake() is None
        assert restored.state is not None
        assert restored.state.waiting_on_delegations == 0
    finally:
        goals._DB_CACHE.clear()
