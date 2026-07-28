"""Disconnecting Copilot must actually clear the token it signed in with.

The GUI device-code flow writes ``COPILOT_GITHUB_TOKEN`` to ``.env`` — that's
what ``resolve_copilot_token()`` reads first. The generic disconnect path only
called ``clear_provider_auth()``, which touches the auth store, so the trash
can reported success while the token kept resolving. The card then rendered as
"connected" with no way to sign in again — the reported symptom.

These tests pin the round-trip: sign-in writes, status sees it, disconnect
clears it, status goes back to offering sign-in.
"""

import os

import pytest

pytest.importorskip("fastapi")

from hermes_cli.web_server import _copilot_status  # noqa: E402


@pytest.fixture
def env_home(tmp_path, monkeypatch):
    """Isolated HERMES_HOME so a test can never touch the real .env."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("COPILOT_GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("GH_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    return home


class TestStatusReflectsTokenSource:
    """_copilot_status distinguishes a device-code token from a gh one."""

    def test_device_code_token_reports_signed_in(self, env_home, monkeypatch):
        monkeypatch.setenv("COPILOT_GITHUB_TOKEN", "ghu_" + "x" * 36)
        status = _copilot_status()
        assert status["logged_in"] is True
        assert status["source"] == "COPILOT_GITHUB_TOKEN"

    def test_gh_sourced_token_is_not_a_copilot_login(self, env_home, monkeypatch):
        """A gh token resolves but 403s on Copilot — it must not read as connected.

        If it did, disconnecting the real device-code token would fall through
        to this one and the sign-in button would never come back.
        """
        import hermes_cli.copilot_auth as ca

        monkeypatch.setattr(
            ca, "resolve_copilot_token", lambda: ("gho_" + "y" * 36, "gh auth token")
        )
        status = _copilot_status()
        assert status["logged_in"] is False
        # Detected, though — the label should say what was found.
        assert "gh" in status["source_label"].lower()
        assert status["token_preview"] is not None

    def test_no_token_reports_not_connected(self, env_home, monkeypatch):
        import hermes_cli.copilot_auth as ca

        monkeypatch.setattr(ca, "resolve_copilot_token", lambda: ("", ""))
        status = _copilot_status()
        assert status["logged_in"] is False
        assert status["token_preview"] is None

    def test_token_is_never_shown_in_full(self, env_home, monkeypatch):
        secret = "ghu_" + "z" * 36
        monkeypatch.setenv("COPILOT_GITHUB_TOKEN", secret)
        preview = _copilot_status()["token_preview"]
        assert preview is not None
        assert secret not in preview


class TestDisconnectClearsEnvToken:
    """The trash can must clear the .env token, not just the auth store."""

    def test_remove_env_value_clears_file_and_process(self, env_home, monkeypatch):
        from hermes_cli.config import remove_env_value, save_env_value

        save_env_value("COPILOT_GITHUB_TOKEN", "ghu_" + "a" * 36)
        assert "COPILOT_GITHUB_TOKEN" in (env_home / ".env").read_text()

        assert remove_env_value("COPILOT_GITHUB_TOKEN") is True
        assert "COPILOT_GITHUB_TOKEN" not in (env_home / ".env").read_text()
        assert os.environ.get("COPILOT_GITHUB_TOKEN") is None

    def test_full_round_trip_restores_sign_in_affordance(self, env_home, monkeypatch):
        """Sign in -> connected; disconnect -> offers sign-in again.

        This is the exact loop that broke: after the trash can the card stayed
        'connected' forever because the token still resolved.
        """
        from hermes_cli.config import remove_env_value, save_env_value

        save_env_value("COPILOT_GITHUB_TOKEN", "ghu_" + "b" * 36)
        assert _copilot_status()["logged_in"] is True

        remove_env_value("COPILOT_GITHUB_TOKEN")

        import hermes_cli.copilot_auth as ca

        # Deliberately DO NOT stub the gh fallback away. Real machines have a
        # gh token, and the resolver falls through to it — that fall-through is
        # what made the card stay "connected" after the trash can. Simulate it.
        monkeypatch.setattr(
            ca, "_try_gh_cli_token", lambda: "gho_" + "f" * 36
        )
        status = _copilot_status()
        assert status["logged_in"] is False, (
            "a gh token must not masquerade as a Copilot login, or the "
            "sign-in button never returns"
        )

    def test_disconnect_is_idempotent(self, env_home):
        """A second delete must not raise — the UI may double-fire."""
        from hermes_cli.config import remove_env_value, save_env_value

        save_env_value("COPILOT_GITHUB_TOKEN", "ghu_" + "c" * 36)
        assert remove_env_value("COPILOT_GITHUB_TOKEN") is True
        assert remove_env_value("COPILOT_GITHUB_TOKEN") is False

    def test_disconnect_leaves_other_keys_intact(self, env_home):
        """Clearing Copilot must not disturb neighbouring credentials."""
        from hermes_cli.config import remove_env_value, save_env_value

        save_env_value("OPENROUTER_API_KEY", "sk-or-keepme")
        save_env_value("COPILOT_GITHUB_TOKEN", "ghu_" + "d" * 36)

        remove_env_value("COPILOT_GITHUB_TOKEN")

        body = (env_home / ".env").read_text()
        assert "sk-or-keepme" in body
        assert "COPILOT_GITHUB_TOKEN" not in body


class TestDisconnectIsNotRefused:
    """A device_code provider must not be rejected as 'external'."""

    def test_copilot_has_no_manual_disconnect_hint(self):
        from hermes_cli.web_server import (
            _OAUTH_PROVIDER_CATALOG,
            _oauth_provider_disconnect_hint,
        )

        entry = next(p for p in _OAUTH_PROVIDER_CATALOG if p["id"] == "copilot")
        # An 'external' card is refused by the disconnect API with a hint;
        # copilot is device_code now, so it must be clearable in-app.
        assert _oauth_provider_disconnect_hint(entry, {}) is None

    def test_copilot_acp_still_refused(self):
        """ACP credentials belong to the Copilot CLI — never delete those."""
        from hermes_cli.web_server import (
            _OAUTH_PROVIDER_CATALOG,
            _oauth_provider_disconnect_hint,
        )

        entry = next(p for p in _OAUTH_PROVIDER_CATALOG if p["id"] == "copilot-acp")
        assert _oauth_provider_disconnect_hint(entry, {}) is not None
