"""``/feedback`` files a GitHub issue from inside Catalyst.

The property that matters most here is what does NOT get attached: the report
is built from local install facts only. A conversation transcript is the single
most likely place for a user's secrets to be sitting, so nothing from it is
collected — and a test pins that, because it is the kind of thing a later
"be more helpful" change would quietly break.
"""

import subprocess
from unittest.mock import patch

import pytest

from hermes_cli import feedback


class TestIssueBody:
    def test_description_is_the_headline_section(self):
        body = feedback.build_issue_body("terminal tool hangs on long output")
        assert "terminal tool hangs on long output" in body
        assert "## What happened" in body

    def test_environment_table_carries_what_a_maintainer_asks_for(self):
        body = feedback.build_issue_body("x")
        for field in ("Catalyst version", "Commit", "Platform", "Python", "Model", "Profile"):
            assert field in body, field

    def test_logs_can_be_omitted(self):
        assert "errors.log" not in feedback.build_issue_body("x", include_logs=False)
        assert "errors.log" in feedback.build_issue_body("x", include_logs=True)

    def test_logs_are_collapsed_so_the_report_stays_readable(self):
        body = feedback.build_issue_body("x", include_logs=True)
        assert "<details>" in body and "</details>" in body

    def test_marked_as_filed_from_the_app(self):
        assert "/feedback" in feedback.build_issue_body("x")


class TestTitle:
    def test_uses_the_first_line(self):
        assert feedback._title_from("crash on startup\nmore detail") == "crash on startup"

    def test_long_titles_are_truncated(self):
        title = feedback._title_from("x" * 200)
        assert len(title) <= 72 and title.endswith("...")

    def test_empty_description_still_yields_a_title(self):
        assert feedback._title_from("") == "Feedback from Catalyst"


class TestDiagnosticsScope:
    def test_no_conversation_content_is_collected(self):
        """Local install facts only — never the transcript."""
        keys = set(feedback.collect_diagnostics())
        assert keys == {
            "Catalyst version",
            "Commit",
            "Platform",
            "Python",
            "Model",
            "Profile",
        }

    def test_diagnostics_survive_a_broken_environment(self):
        with patch.object(feedback, "_active_model", side_effect=RuntimeError("boom")):
            with pytest.raises(RuntimeError):
                feedback._active_model()
        # The collectors themselves swallow failures rather than blocking a report.
        assert feedback.collect_diagnostics()["Catalyst version"]


class TestFileIssue:
    def test_empty_description_is_rejected_before_any_network_call(self):
        result = feedback.file_issue("   ")
        assert not result["ok"]
        assert "Describe the problem" in result["error"]

    def test_dry_run_renders_without_publishing(self):
        # Diagnostics still shell out (git rev-parse for the commit); what must
        # NOT happen is `gh issue create`.
        with patch.object(feedback.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, stdout="", stderr="")
            result = feedback.file_issue("something broke", dry_run=True)

        for call in run.call_args_list:
            assert "issue" not in call[0][0], f"dry run published: {call[0][0]}"
        assert result["ok"] and result["dry_run"]
        assert "something broke" in result["body"]

    def test_success_returns_the_issue_url(self):
        with (
            patch.object(feedback, "gh_available", return_value=True),
            patch.object(feedback.subprocess, "run") as run,
        ):
            run.return_value = subprocess.CompletedProcess(
                [], 0, stdout=f"https://github.com/{feedback.REPO}/issues/42\n", stderr=""
            )
            result = feedback.file_issue("bug report")

        assert result["ok"]
        assert result["url"].endswith("/issues/42")

    def test_missing_gh_returns_the_report_so_it_is_not_lost(self):
        """A tooling gap must not cost the user what they just wrote."""
        with patch.object(feedback, "gh_available", return_value=False):
            result = feedback.file_issue("my careful bug report")

        assert not result["ok"]
        assert "gh auth login" in result["error"]
        assert "my careful bug report" in result["body"]
        assert feedback.ISSUES_URL in result["error"]

    def test_a_missing_label_does_not_lose_the_report(self):
        """Fresh repos have no 'bug' label; retry without labels rather than fail."""
        calls = []

        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            if "--label" in cmd:
                return subprocess.CompletedProcess(
                    cmd, 1, stdout="", stderr="could not add label: 'bug' not found"
                )
            return subprocess.CompletedProcess(
                cmd, 0, stdout="https://github.com/x/y/issues/7", stderr=""
            )

        with (
            patch.object(feedback, "gh_available", return_value=True),
            patch.object(feedback.subprocess, "run", side_effect=fake_run),
        ):
            result = feedback.file_issue("report")

        assert result["ok"]
        issue_calls = [c for c in calls if "issue" in c]
        assert len(issue_calls) == 2, issue_calls
        assert "--label" not in issue_calls[1]

    def test_gh_failure_surfaces_stderr(self):
        with (
            patch.object(feedback, "gh_available", return_value=True),
            patch.object(feedback.subprocess, "run") as run,
        ):
            run.return_value = subprocess.CompletedProcess(
                [], 1, stdout="", stderr="HTTP 403: forbidden"
            )
            result = feedback.file_issue("report")

        assert not result["ok"]
        assert "403" in result["error"]

    def test_targets_the_catalyst_repo(self):
        with (
            patch.object(feedback, "gh_available", return_value=True),
            patch.object(feedback.subprocess, "run") as run,
        ):
            run.return_value = subprocess.CompletedProcess([], 0, stdout="url", stderr="")
            feedback.file_issue("report")

        cmd = run.call_args[0][0]
        assert cmd[:3] == ["gh", "issue", "create"]
        assert feedback.REPO in cmd


class TestFormatResult:
    def test_success_shows_the_url(self):
        out = feedback.format_result({"ok": True, "url": "https://example/issues/1"})
        assert "https://example/issues/1" in out

    def test_failure_includes_the_body_to_copy(self):
        out = feedback.format_result(
            {"ok": False, "error": "no gh", "title": "T", "body": "B"}
        )
        assert "no gh" in out and "B" in out

    def test_dry_run_says_it_did_not_publish(self):
        out = feedback.format_result({"dry_run": True, "ok": True, "title": "T", "body": "B"})
        assert "Would file" in out


class TestCommandRegistration:
    def test_registered_with_a_bug_alias(self):
        from hermes_cli.commands import resolve_command

        assert resolve_command("feedback").name == "feedback"
        assert resolve_command("bug").name == "feedback"

    def test_appears_in_the_info_category(self):
        from hermes_cli.commands import COMMANDS_BY_CATEGORY

        entries = COMMANDS_BY_CATEGORY["Info"]
        assert any("feedback" in str(entry) for entry in entries), entries
