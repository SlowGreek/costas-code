"""Subagent runs must never reach the resume picker.

A single dynamic-workflow fan-out or ``delegate_task`` batch creates dozens of
session rows. They are real sessions with real transcripts — useful for
``session_search``, useless in a picker — and when they leak they bury the
user's actual conversations under a wall of identical child titles.

The bug these pin: the deny-list was ``{"tool"}`` while
``_build_child_agent`` stamps children with ``platform="subagent"``, so every
child slipped straight through. Two copies of that literal disagreed
independently, which is why the constant is now shared.
"""

import pytest

from tui_gateway import server


def _call(method, **params):
    """Invoke a registered JSON-RPC method the way the other suites do."""
    return server._methods[method](1, params)


class TestNonHumanSessionSources:
    def test_subagent_is_denied(self):
        # The label delegate_task / workflow children actually carry.
        assert "subagent" in server._NON_HUMAN_SESSION_SOURCES

    def test_legacy_tool_label_is_still_denied(self):
        # Older databases hold rows written under the previous name.
        assert "tool" in server._NON_HUMAN_SESSION_SOURCES

    def test_human_surfaces_are_not_denied(self):
        # Deny-list, not allow-list: a new platform must not need a code change
        # to show up in the picker.
        for source in ("desktop", "cli", "tui", "telegram", "discord", "slack", "acp", "cron"):
            assert source not in server._NON_HUMAN_SESSION_SOURCES, source


class _FakeDB:
    def __init__(self, rows):
        self._rows = rows

    def list_sessions_rich(self, **kwargs):
        return self._rows


def _row(sid, source, title=""):
    return {
        "id": sid,
        "source": source,
        "title": title,
        "preview": "",
        "started_at": 0,
        "message_count": 1,
    }


@pytest.fixture
def rows():
    """One real conversation buried under a workflow fan-out."""
    return [
        _row("wf-1", "subagent", "You are auditing a downstream fork..."),
        _row("wf-2", "subagent", "You are auditing a downstream fork..."),
        _row("wf-3", "subagent", "You are auditing a downstream fork..."),
        _row("real-1", "desktop", "Why /goal didn't show the goal UI"),
        _row("old-1", "tool", "legacy child run"),
        _row("real-2", "cli", "Actual conversation"),
    ]


class TestSessionList:
    def test_only_human_sessions_are_listed(self, rows, monkeypatch):
        monkeypatch.setattr(server, "_get_db", lambda: _FakeDB(rows))

        result = _call("session.list")
        listed = [s["id"] for s in result["result"]["sessions"]]

        assert listed == ["real-1", "real-2"]

    def test_a_fan_out_cannot_bury_real_sessions(self, monkeypatch):
        """50 children must not push the one real session out of the list."""
        many = [_row(f"wf-{i}", "subagent", "You are auditing...") for i in range(50)]
        many.append(_row("real-1", "desktop", "The actual conversation"))
        monkeypatch.setattr(server, "_get_db", lambda: _FakeDB(many))

        result = _call("session.list", **{"limit": 20})
        listed = [s["id"] for s in result["result"]["sessions"]]

        assert listed == ["real-1"]

    def test_source_casing_and_padding_do_not_defeat_the_filter(self, monkeypatch):
        odd = [_row("a", " SubAgent "), _row("b", "TOOL"), _row("c", "desktop")]
        monkeypatch.setattr(server, "_get_db", lambda: _FakeDB(odd))

        result = _call("session.list")
        assert [s["id"] for s in result["result"]["sessions"]] == ["c"]


class TestMostRecentSession:
    def test_auto_resume_skips_subagents(self, rows, monkeypatch):
        """Auto-resume landing the user inside a subagent run is worse than
        listing one — it hijacks the session they meant to continue."""
        monkeypatch.setattr(server, "_get_db", lambda: _FakeDB(rows))

        result = _call("session.most_recent")
        assert result["result"]["session_id"] == "real-1"

    def test_all_subagents_yields_no_session(self, monkeypatch):
        only_children = [_row("wf-1", "subagent"), _row("wf-2", "subagent")]
        monkeypatch.setattr(server, "_get_db", lambda: _FakeDB(only_children))

        result = _call("session.most_recent")
        assert result["result"]["session_id"] is None


class TestBothPathsAgree:
    def test_list_and_most_recent_use_the_same_deny_list(self, monkeypatch):
        """These drifted apart once already — the whole reason for the shared
        constant. If they disagree, the picker hides a row that auto-resume
        will happily drop you into."""
        data = [_row("wf-1", "subagent"), _row("real-1", "desktop")]
        monkeypatch.setattr(server, "_get_db", lambda: _FakeDB(data))

        listed = [
            s["id"]
            for s in _call("session.list")["result"][
                "sessions"
            ]
        ]
        recent = _call("session.most_recent")[
            "result"
        ]["session_id"]

        assert recent in listed
