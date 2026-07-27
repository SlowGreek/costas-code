"""The token counter must be live during a turn and correct before one.

Two bugs these pin:

1. ``session.info`` is only emitted from the turn-end ``finally`` block, so a
   long multi-tool turn froze the status bar's context gauge at its pre-turn
   value and jumped at the end. ``_emit_usage_update`` now fires after every
   tool call.

2. A freshly-constructed ``AIAgent`` zeroes its ``session_*_tokens`` counters
   (run_agent.py), so a resumed / branched / subagent session reported 0
   tokens until its first turn completed — even with hundreds of messages of
   real history behind it. ``_lazy_resume_info`` now seeds the gauge from the
   persisted per-session totals.
"""

import pytest

from tui_gateway import server


@pytest.fixture
def emitted(monkeypatch):
    """Capture events instead of writing them to a transport."""
    events = []
    monkeypatch.setattr(server, "_emit", lambda kind, sid, payload=None: events.append((kind, sid, payload)))
    return events


class TestMidTurnUsageEmit:
    def test_emits_usage_for_a_live_session(self, emitted, monkeypatch):
        monkeypatch.setitem(server._sessions, "s1", {"agent": object()})
        monkeypatch.setattr(server, "_session_usage_snapshot", lambda _s: {"input": 42, "total": 99})

        server._emit_usage_update("s1")

        assert emitted == [("usage.update", "s1", {"usage": {"input": 42, "total": 99}})]

    def test_unknown_session_is_a_noop(self, emitted):
        server._emit_usage_update("does-not-exist")
        assert emitted == []

    def test_empty_usage_is_not_emitted(self, emitted, monkeypatch):
        # An agent that hasn't made an API call yet has nothing to report;
        # emitting {} would clobber a good count with zeroes in the UI merge.
        monkeypatch.setitem(server._sessions, "s2", {"agent": object()})
        monkeypatch.setattr(server, "_session_usage_snapshot", lambda _s: {})

        server._emit_usage_update("s2")

        assert emitted == []

    def test_snapshot_failure_does_not_raise(self, emitted, monkeypatch):
        # This runs on the tool-completion path — a usage read that throws must
        # never take down the turn.
        def boom(_s):
            raise RuntimeError("db gone")

        monkeypatch.setitem(server._sessions, "s3", {"agent": object()})
        monkeypatch.setattr(server, "_session_usage_snapshot", boom)

        server._emit_usage_update("s3")

        assert emitted == []


class _FakeDB:
    def __init__(self, record):
        self._record = record

    def get_session(self, _sid):
        return self._record


class TestStoredUsageSeed:
    def _patch_db(self, monkeypatch, record):
        import hermes_state

        monkeypatch.setattr(hermes_state, "SessionDB", lambda *a, **k: _FakeDB(record))

    def test_seeds_from_persisted_totals(self, monkeypatch):
        self._patch_db(
            monkeypatch,
            {
                "input_tokens": 29812,
                "output_tokens": 9394,
                "reasoning_tokens": 12,
                "api_call_count": 33,
                "model": "claude-opus-5",
            },
        )

        usage = server._stored_usage_for_session("20260727_135555_de5c31")

        assert usage["input"] == 29812
        assert usage["output"] == 9394
        assert usage["total"] == 29812 + 9394
        assert usage["calls"] == 33
        assert usage["model"] == "claude-opus-5"

    def test_blank_session_key_is_a_noop(self):
        assert server._stored_usage_for_session("") == {}
        assert server._stored_usage_for_session("   ") == {}

    def test_missing_record_returns_empty(self, monkeypatch):
        self._patch_db(monkeypatch, None)
        assert server._stored_usage_for_session("nope") == {}

    def test_zero_usage_returns_empty(self, monkeypatch):
        # A brand-new session has no tokens yet. Returning zeroes here would
        # overwrite a live agent's real count with 0 on the merge.
        self._patch_db(monkeypatch, {"input_tokens": 0, "output_tokens": 0})
        assert server._stored_usage_for_session("fresh") == {}

    def test_db_failure_returns_empty(self, monkeypatch):
        import hermes_state

        def boom(*a, **k):
            raise RuntimeError("locked")

        monkeypatch.setattr(hermes_state, "SessionDB", boom)
        assert server._stored_usage_for_session("any") == {}


class TestLazyResumeInfoCarriesUsage:
    def test_usage_attached_when_history_exists(self, monkeypatch):
        monkeypatch.setattr(
            server, "_stored_usage_for_session", lambda _k: {"input": 100, "total": 150}
        )
        monkeypatch.setattr(server, "_git_branch_for_cwd", lambda _c: "")
        monkeypatch.setattr(server, "_project_info_for_cwd", lambda _c: None)
        monkeypatch.setattr(server, "_resolve_model", lambda: "m")
        monkeypatch.setattr(server, "_current_profile_name", lambda: "default")

        info = server._lazy_resume_info("/tmp", session_key="sess-1")

        assert info["usage"] == {"input": 100, "total": 150}

    def test_no_usage_key_when_nothing_stored(self, monkeypatch):
        # Absent is meaningfully different from zero: the desktop merges usage
        # over its current value, so an explicit {} would blank a live count.
        monkeypatch.setattr(server, "_stored_usage_for_session", lambda _k: {})
        monkeypatch.setattr(server, "_git_branch_for_cwd", lambda _c: "")
        monkeypatch.setattr(server, "_project_info_for_cwd", lambda _c: None)
        monkeypatch.setattr(server, "_resolve_model", lambda: "m")
        monkeypatch.setattr(server, "_current_profile_name", lambda: "default")

        info = server._lazy_resume_info("/tmp", session_key="sess-1")

        assert "usage" not in info
