"""GitHub Copilot must be connectable from the desktop Accounts UI.

The setup failure this addresses: `gh auth login` gets you the repo but NOT
Copilot. Its token is `gho_`/`ghp_`, scoped to the GitHub API, and the Copilot
endpoint answers "403 Access to this endpoint is forbidden" — which reads like a
subscription or entitlement problem and sends people looking for header
workarounds. The actual fix is a second, different login: the device-code flow
that mints a `ghu_` token.

Before this, the OAuth catalog only had `copilot-acp`, which shells out to the
separate Copilot CLI binary. There was no GUI affordance for the flow Hermes
itself implements, so the only route was knowing to run `hermes model` and pick
the right submenu.
"""

from unittest.mock import patch

import pytest


def _catalog_ids():
    from hermes_cli.web_server import _OAUTH_PROVIDER_CATALOG

    return [entry["id"] for entry in _OAUTH_PROVIDER_CATALOG]


class TestCopilotInOAuthCatalog:
    def test_copilot_is_offered(self):
        assert "copilot" in _catalog_ids()

    def test_it_is_distinct_from_the_acp_entry(self):
        """Different credentials, different flows — one cannot stand in for the
        other. copilot-acp defers to the Copilot CLI's own login."""
        ids = _catalog_ids()
        assert "copilot" in ids and "copilot-acp" in ids

    def test_it_points_at_the_device_code_flow(self):
        from hermes_cli.web_server import _OAUTH_PROVIDER_CATALOG

        entry = next(e for e in _OAUTH_PROVIDER_CATALOG if e["id"] == "copilot")
        # `gh auth login` is the wrong instruction here and would reproduce the
        # exact 403 this entry exists to prevent.
        assert "gh auth" not in entry["cli_command"]
        assert entry["cli_command"] == "hermes model"

    def test_it_has_a_status_probe(self):
        from hermes_cli.web_server import _OAUTH_PROVIDER_CATALOG

        entry = next(e for e in _OAUTH_PROVIDER_CATALOG if e["id"] == "copilot")
        assert callable(entry["status_fn"])


class TestCopilotStatus:
    def _status(self, resolve_result=None, raises=False):
        from hermes_cli import web_server

        target = "hermes_cli.copilot_auth.resolve_copilot_token"
        if raises:
            with patch(target, side_effect=RuntimeError("boom")):
                return web_server._copilot_status()
        with patch(target, return_value=resolve_result):
            return web_server._copilot_status()

    def test_no_token_reports_disconnected(self):
        status = self._status(("", ""))
        assert status["logged_in"] is False
        assert status["source_label"] == "Not connected"

    def test_device_code_token_reports_signed_in(self):
        status = self._status(("ghu_abcd1234efgh", "COPILOT_GITHUB_TOKEN"))
        assert status["logged_in"] is True
        assert "device code" in status["source_label"].lower()

    def test_a_gh_sourced_token_is_flagged_not_celebrated(self):
        """The failure mode worth preventing: a green 'connected' badge on a
        token that 403s on the first model call.

        Strengthened after the trash-can bug: a gh token must not merely be
        *labelled* as doubtful, it must not count as logged_in at all. When it
        did, disconnecting the real device-code token fell through to the gh
        token and the sign-in button never came back.
        """
        status = self._status(("gho_abcd1234efgh", "gh auth token"))
        assert status["logged_in"] is False
        assert "gh" in status["source_label"].lower()

    def test_the_token_is_never_shown_in_full(self):
        status = self._status(("ghu_abcdefghijklmnop", "COPILOT_GITHUB_TOKEN"))
        preview = status["token_preview"] or ""
        assert "abcdefghijklmnop" not in preview
        assert "…" in preview

    def test_a_probe_failure_degrades_to_disconnected(self):
        # A broken probe must not take down the whole Accounts page.
        status = self._status(raises=True)
        assert status["logged_in"] is False

    def test_status_shape_matches_the_other_providers(self):
        status = self._status(("ghu_abcd1234efgh", "COPILOT_GITHUB_TOKEN"))
        for key in (
            "logged_in",
            "source",
            "source_label",
            "token_preview",
            "expires_at",
            "has_refresh_token",
        ):
            assert key in status, key
