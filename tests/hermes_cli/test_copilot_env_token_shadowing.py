"""Env-var tokens must not silently shadow the signed-in ``gh`` account.

Env-var tokens deliberately outrank the GitHub CLI — the official runtime
orders ``AuthMethod::GitHubToken`` above ``AuthMethod::GhCli``
(``runtime/src/auth/manager_orchestration.rs``), and scripted/CI setups rely
on it. The hazard is that the override used to be *silent*: with
``COPILOT_GITHUB_TOKEN`` exported, ``gh auth switch`` appears to change
accounts but changes nothing, so an account switch that looks successful still
authenticates as the previous user.

These tests pin the behaviour: precedence unchanged, but the conflict is
reported.
"""

from __future__ import annotations

import logging

import pytest


@pytest.fixture(autouse=True)
def _reset_warning_latch(monkeypatch):
    """The warning is latched once per process; reset it between tests."""
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setattr(copilot_auth, "_shadow_warning_emitted", False)
    for var in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        monkeypatch.delenv(var, raising=False)


# ── precedence is unchanged ──────────────────────────────────────────────────


def test_env_token_still_wins_over_gh_cli(monkeypatch):
    """Matches the reference AuthMethod order; CI/scripts depend on this."""
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "ghu_env_token")
    monkeypatch.setattr(copilot_auth, "_try_gh_cli_token", lambda: "gho_cli_token")
    monkeypatch.setattr(copilot_auth, "_gh_active_login", lambda: "other-user")

    token, source = copilot_auth.resolve_copilot_token()

    assert token == "ghu_env_token"
    assert source == "COPILOT_GITHUB_TOKEN"


def test_gh_cli_is_used_when_no_env_token_is_set(monkeypatch):
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setattr(copilot_auth, "_try_gh_cli_token", lambda: "gho_cli_token")

    token, source = copilot_auth.resolve_copilot_token()

    assert token == "gho_cli_token"
    assert source == "gh auth token"


# ── the override is reported ─────────────────────────────────────────────────


def test_warns_when_env_token_shadows_a_different_gh_account(monkeypatch, caplog):
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "ghu_env_token")
    monkeypatch.setattr(copilot_auth, "_try_gh_cli_token", lambda: "gho_cli_token")
    monkeypatch.setattr(copilot_auth, "_gh_active_login", lambda: "costaspanay_microsoft")

    with caplog.at_level(logging.WARNING, logger=copilot_auth.logger.name):
        copilot_auth.resolve_copilot_token()

    message = caplog.text
    assert "COPILOT_GITHUB_TOKEN" in message
    assert "costaspanay_microsoft" in message
    # It must say the switch has no effect — that is the whole point.
    assert "gh auth switch" in message


def test_warning_is_emitted_only_once_per_process(monkeypatch, caplog):
    """Token resolution is a hot path; a repeated warning is a log storm."""
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "ghu_env_token")
    monkeypatch.setattr(copilot_auth, "_try_gh_cli_token", lambda: "gho_cli_token")
    monkeypatch.setattr(copilot_auth, "_gh_active_login", lambda: "other-user")

    with caplog.at_level(logging.WARNING, logger=copilot_auth.logger.name):
        for _ in range(5):
            copilot_auth.resolve_copilot_token()

    assert caplog.text.count("gh auth switch") == 1


def test_no_warning_when_gh_serves_the_same_token(monkeypatch, caplog):
    """Nothing is being overridden, so there is nothing to report."""
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "ghu_same")
    monkeypatch.setattr(copilot_auth, "_try_gh_cli_token", lambda: "ghu_same")
    monkeypatch.setattr(copilot_auth, "_gh_active_login", lambda: "same-user")

    with caplog.at_level(logging.WARNING, logger=copilot_auth.logger.name):
        copilot_auth.resolve_copilot_token()

    assert "gh auth switch" not in caplog.text


def test_no_warning_when_gh_is_not_installed_or_logged_out(monkeypatch, caplog):
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "ghu_env_token")
    monkeypatch.setattr(copilot_auth, "_try_gh_cli_token", lambda: None)

    with caplog.at_level(logging.WARNING, logger=copilot_auth.logger.name):
        copilot_auth.resolve_copilot_token()

    assert "gh auth switch" not in caplog.text


def test_shadowing_check_never_breaks_token_resolution(monkeypatch):
    """Diagnostics must not be able to take auth down."""
    import hermes_cli.copilot_auth as copilot_auth

    def _boom():
        raise RuntimeError("gh exploded")

    monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "ghu_env_token")
    monkeypatch.setattr(copilot_auth, "_try_gh_cli_token", _boom)

    token, source = copilot_auth.resolve_copilot_token()

    assert token == "ghu_env_token"
    assert source == "COPILOT_GITHUB_TOKEN"


# ── the helper itself ────────────────────────────────────────────────────────


def test_shadow_helper_reports_the_shadowed_login(monkeypatch):
    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setattr(copilot_auth, "_try_gh_cli_token", lambda: "gho_other")
    monkeypatch.setattr(copilot_auth, "_gh_active_login", lambda: "corp-user")

    assert (
        copilot_auth.env_token_shadows_gh_account("COPILOT_GITHUB_TOKEN", "ghu_env")
        == "corp-user"
    )


def test_shadow_helper_returns_none_for_empty_token(monkeypatch):
    import hermes_cli.copilot_auth as copilot_auth

    assert copilot_auth.env_token_shadows_gh_account("COPILOT_GITHUB_TOKEN", "") is None


def test_active_login_parses_gh_auth_status(monkeypatch):
    """Only the account marked ``Active account: true`` is returned."""
    import subprocess

    import hermes_cli.copilot_auth as copilot_auth

    status = (
        "github.com\n"
        "  ✓ Logged in to github.com account SlowGreek (keyring)\n"
        "  - Active account: false\n"
        "  ✓ Logged in to github.com account costaspanay_microsoft (keyring)\n"
        "  - Active account: true\n"
    )

    monkeypatch.setattr(copilot_auth, "_gh_cli_candidates", lambda: ["/usr/bin/gh"])
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: subprocess.CompletedProcess(a[0], 0, status, ""),
    )

    assert copilot_auth._gh_active_login() == "costaspanay_microsoft"


def test_active_login_returns_none_when_no_account_is_active(monkeypatch):
    import subprocess

    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setattr(copilot_auth, "_gh_cli_candidates", lambda: ["/usr/bin/gh"])
    monkeypatch.setattr(
        subprocess, "run",
        lambda *a, **k: subprocess.CompletedProcess(a[0], 1, "", "not logged in"),
    )

    assert copilot_auth._gh_active_login() is None


def test_shadowing_lookup_does_not_leak_the_token_into_the_gh_env(monkeypatch):
    """``gh auth status`` must read its own store, not echo our env token back."""
    import subprocess

    import hermes_cli.copilot_auth as copilot_auth

    monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "ghu_secret")
    monkeypatch.setenv("GH_TOKEN", "gho_secret")
    monkeypatch.setattr(copilot_auth, "_gh_cli_candidates", lambda: ["/usr/bin/gh"])

    seen: dict = {}

    def _capture(*args, **kwargs):
        seen.update(kwargs.get("env") or {})
        return subprocess.CompletedProcess(args[0], 1, "", "")

    monkeypatch.setattr(subprocess, "run", _capture)
    copilot_auth._gh_active_login()

    assert "COPILOT_GITHUB_TOKEN" not in seen
    assert "GH_TOKEN" not in seen
    assert "GITHUB_TOKEN" not in seen
