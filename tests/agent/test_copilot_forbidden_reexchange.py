"""A Copilot 403 from a rotated API token must self-heal, once.

GitHub can revoke or rotate the exchanged Copilot API token before the
``expires_at`` it advertised. Hermes keeps serving the cached JWT (the
in-process ``_jwt_cache`` and the on-disk store) until that stale expiry, so
every request 403s and only a process restart — which re-runs the exchange —
recovers. The 401 refresh branch never fires (status is 403) and the 400
stale-credential branch requires a ``model_not_available`` marker.

These tests pin the classifier that decides when a 403 is worth a forced
re-exchange, and the guard that keeps it single-shot. The retry must NOT fire
for 403s a fresh token cannot fix (no seat, no subscription, org policy) —
there, re-exchanging just hides the real message behind an extra round-trip.
"""

import pytest

from agent.conversation_loop import (
    _copilot_error_haystack,
    _is_recoverable_copilot_forbidden,
)
from agent.turn_retry_state import TurnRetryState


class _Resp:
    def __init__(self, text):
        self.text = text


class _Err(Exception):
    def __init__(self, message, *, body=None, response=None):
        super().__init__(message)
        self.message = message
        self.body = body
        self.response = response


class TestRecoverableForbidden:
    def test_plain_403_is_recoverable(self):
        assert _is_recoverable_copilot_forbidden(
            403, "Access to this endpoint is forbidden."
        )

    def test_empty_body_403_is_recoverable(self):
        # No body to inspect: assume the common cause (rotated token) and let
        # the single-shot retry decide. A second 403 surfaces normally.
        assert _is_recoverable_copilot_forbidden(403, "")

    @pytest.mark.parametrize("status", [None, 400, 401, 404, 429, 500])
    def test_non_403_never_matches(self, status):
        assert not _is_recoverable_copilot_forbidden(status, "forbidden")

    @pytest.mark.parametrize(
        "body",
        [
            "You have no active subscription to GitHub Copilot",
            "This user does not have a Copilot license",
            "Your Copilot seat was removed",
            "Requester is not entitled to this model",
            "subscription required",
            "Request blocked by content exclusion policy",
            "Copilot is disabled by your organization",
            "This model is not enabled for your organization",
        ],
    )
    def test_entitlement_and_policy_403s_are_not_recoverable(self, body):
        assert not _is_recoverable_copilot_forbidden(403, body)

    def test_marker_match_is_case_insensitive(self):
        assert not _is_recoverable_copilot_forbidden(
            403, "NO ACTIVE SUBSCRIPTION FOR THIS ACCOUNT"
        )


class TestErrorHaystack:
    """The exclusion markers only work if we can see the real body text."""

    def test_message_only(self):
        assert "forbidden" in _copilot_error_haystack(_Err("403 forbidden"))

    def test_structured_body_is_included(self):
        err = _Err("boom", body={"error": {"message": "no active subscription"}})
        assert not _is_recoverable_copilot_forbidden(403, _copilot_error_haystack(err))

    def test_response_text_is_included(self):
        err = _Err("boom", response=_Resp("Copilot is disabled by your organization"))
        assert not _is_recoverable_copilot_forbidden(403, _copilot_error_haystack(err))

    def test_response_without_text_attribute(self):
        err = _Err("boom", response={"detail": "not entitled"})
        assert not _is_recoverable_copilot_forbidden(403, _copilot_error_haystack(err))

    def test_unreadable_body_does_not_raise(self):
        class _Boom:
            def __str__(self):  # pragma: no cover - exercised via haystack
                raise RuntimeError("nope")

        err = _Err("403 forbidden", body=_Boom())
        assert "forbidden" in _copilot_error_haystack(err)


class TestRetryGuard:
    def test_forbidden_guard_defaults_false_and_is_independent(self):
        state = TurnRetryState()
        assert state.copilot_forbidden_retry_attempted is False
        state.copilot_forbidden_retry_attempted = True
        # The 401 and 400 recovery paths must stay independently available
        # within the same attempt.
        assert state.copilot_auth_retry_attempted is False
        assert state.copilot_stale_cred_retry_attempted is False
