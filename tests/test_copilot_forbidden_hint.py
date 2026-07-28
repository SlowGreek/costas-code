"""Copilot 403 "Terms of Service" errors must name the real cause.

``api.githubcopilot.com`` returns legal boilerplate ("Access to this endpoint
is forbidden. Please review our Terms of Service") when it rejects a caller.
The common cause is that Hermes is sending a RAW GitHub token because the
``/copilot_internal/v2/token`` exchange refused it — ``gho_`` tokens from
``gh auth login`` cannot be exchanged, only ``ghu_`` device-code tokens can.

Individual Copilot plans tolerate the raw token on the generic host, so the
fallback looks harmless. Managed/enterprise accounts are served off an
account-specific endpoint that only the exchange reveals, so the same fallback
403s there. These tests pin the relationship: the hint appears only when the
fallback is actually active.
"""

import pytest

import hermes_cli.copilot_auth as copilot_auth
from run_agent import AIAgent


_FORBIDDEN = (
    "HTTP 403: Access to this endpoint is forbidden. "
    "Please review our Terms of Service"
)


@pytest.fixture(autouse=True)
def _clear_fallback_state():
    """Each test owns the module-level fallback set."""
    copilot_auth._exchange_fallback_fingerprints.clear()
    yield
    copilot_auth._exchange_fallback_fingerprints.clear()


class TestFallbackStateTracking:
    """get_copilot_api_token records whether the raw token is in play."""

    def test_no_fallback_before_any_exchange(self):
        assert copilot_auth.copilot_raw_token_fallback_active() is False

    def test_failed_exchange_marks_fallback_active(self, monkeypatch):
        monkeypatch.setattr(
            copilot_auth,
            "exchange_copilot_token",
            lambda *a, **kw: (_ for _ in ()).throw(ValueError("403 Forbidden")),
        )
        token, base_url = copilot_auth.get_copilot_api_token("gho_raw")
        # Fallback returns the raw token verbatim with no account endpoint.
        assert token == "gho_raw"
        assert base_url is None
        assert copilot_auth.copilot_raw_token_fallback_active() is True

    def test_successful_exchange_clears_fallback(self, monkeypatch):
        monkeypatch.setattr(
            copilot_auth,
            "exchange_copilot_token",
            lambda *a, **kw: (_ for _ in ()).throw(ValueError("nope")),
        )
        copilot_auth.get_copilot_api_token("ghu_tok")
        assert copilot_auth.copilot_raw_token_fallback_active() is True

        monkeypatch.setattr(
            copilot_auth,
            "exchange_copilot_token",
            lambda *a, **kw: ("exchanged", 0.0, "https://api.enterprise.githubcopilot.com"),
        )
        token, base_url = copilot_auth.get_copilot_api_token("ghu_tok")
        assert token == "exchanged"
        assert base_url == "https://api.enterprise.githubcopilot.com"
        assert copilot_auth.copilot_raw_token_fallback_active() is False

    def test_empty_token_does_not_mark_fallback(self):
        assert copilot_auth.get_copilot_api_token("") == ("", None)
        assert copilot_auth.copilot_raw_token_fallback_active() is False


class TestForbiddenDecoration:
    """The hint is tied to fallback state, not to the message text alone."""

    def _mark_fallback(self, monkeypatch):
        monkeypatch.setattr(
            copilot_auth,
            "exchange_copilot_token",
            lambda *a, **kw: (_ for _ in ()).throw(ValueError("403")),
        )
        copilot_auth.get_copilot_api_token("gho_raw")

    def test_hint_added_when_fallback_active(self, monkeypatch):
        self._mark_fallback(monkeypatch)
        out = AIAgent._decorate_copilot_forbidden_error(_FORBIDDEN)
        assert out.startswith(_FORBIDDEN)
        assert "could not be exchanged" in out
        assert "device-code" in out

    def test_no_hint_when_fallback_inactive(self):
        # A real policy/ToS block must not be mislabelled as an auth problem.
        assert AIAgent._decorate_copilot_forbidden_error(_FORBIDDEN) == _FORBIDDEN

    def test_unrelated_error_untouched(self, monkeypatch):
        self._mark_fallback(monkeypatch)
        other = "HTTP 500: upstream exploded"
        assert AIAgent._decorate_copilot_forbidden_error(other) == other

    def test_empty_detail_untouched(self, monkeypatch):
        self._mark_fallback(monkeypatch)
        assert AIAgent._decorate_copilot_forbidden_error("") == ""

    def test_decoration_is_idempotent(self, monkeypatch):
        self._mark_fallback(monkeypatch)
        once = AIAgent._decorate_copilot_forbidden_error(_FORBIDDEN)
        twice = AIAgent._decorate_copilot_forbidden_error(once)
        assert once == twice


class _Resp:
    def __init__(self, text):
        self.text = text


class _Err(Exception):
    def __init__(self, message, *, status_code=None, body=None, response=None):
        super().__init__(message)
        self.status_code = status_code
        self.body = body
        self.response = response


class TestSummarizeApiErrorIntegration:
    """_summarize_api_error routes Copilot 403s through the decorator."""

    def _mark_fallback(self, monkeypatch):
        monkeypatch.setattr(
            copilot_auth,
            "exchange_copilot_token",
            lambda *a, **kw: (_ for _ in ()).throw(ValueError("403")),
        )
        copilot_auth.get_copilot_api_token("gho_raw")

    def test_structured_body_path(self, monkeypatch):
        self._mark_fallback(monkeypatch)
        err = _Err(
            "boom",
            status_code=403,
            body={"error": {"message": "Access to this endpoint is forbidden."}},
        )
        assert "could not be exchanged" in AIAgent._summarize_api_error(err)

    def test_response_text_path(self, monkeypatch):
        """GitHub's 403 arrives as raw response text, not an SDK body."""
        self._mark_fallback(monkeypatch)
        err = _Err(
            "boom",
            status_code=403,
            response=_Resp(
                "Access to this endpoint is forbidden. "
                "Please review our Terms of Service"
            ),
        )
        assert "could not be exchanged" in AIAgent._summarize_api_error(err)

    def test_raw_string_fallback_path(self, monkeypatch):
        self._mark_fallback(monkeypatch)
        err = _Err("Access to this endpoint is forbidden.", status_code=403)
        assert "could not be exchanged" in AIAgent._summarize_api_error(err)

    def test_untouched_without_fallback(self):
        err = _Err(
            "boom",
            status_code=403,
            response=_Resp("Access to this endpoint is forbidden."),
        )
        assert "could not be exchanged" not in AIAgent._summarize_api_error(err)
