import base64
import json
import threading
import time
import urllib.error

import pytest

from tui_gateway.peeps_voice_auth import (
    PeepsAuthError,
    PeepsCognitiveTokenProvider,
    PeepsVoiceAuthConfig,
    PeepsVoiceAuthSessionStore,
)


def _jwt(payload):
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return f"header.{body}.signature"


def _config(**overrides):
    return PeepsVoiceAuthConfig.from_dict(
        {
            "enabled": True,
            "client_id": "client",
            "authority": "https://login.microsoftonline.com/organizations",
            "scope": "https://peeps.asgprototype.com/api/access-as-user",
            "redirect_uri": "https://localhost:8080/",
            "cognitive_token_url": "https://seastarserviceapp-develop.azurewebsites.net/token/getCognitiveServicesToken",
            "timeout_seconds": 180,
            **overrides,
        }
    )


class _Response:
    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit=-1):
        return self._payload


def test_auth_session_rejects_replay_wrong_state_wrong_profile_and_expiry():
    now = {"value": 100.0}
    store = PeepsVoiceAuthSessionStore(monotonic=lambda: now["value"])
    session = store.start("profile-a", _config(timeout_seconds=3))
    token = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300})

    with pytest.raises(PeepsAuthError, match="invalid or expired") as wrong_state:
        store.complete_browser_auth(
            "profile-a", session["auth_session_id"], "wrong-state", token
        )
    assert wrong_state.value.code == "wrong_state"

    with pytest.raises(PeepsAuthError, match="invalid or expired") as wrong_profile:
        store.complete_browser_auth(
            "profile-b", session["auth_session_id"], session["state"], token
        )
    assert wrong_profile.value.code == "wrong_profile"

    now["value"] += 4
    with pytest.raises(PeepsAuthError, match="invalid or expired") as expired:
        store.complete_browser_auth(
            "profile-a", session["auth_session_id"], session["state"], token
        )
    assert expired.value.code == "unknown_auth_session"

    fresh = store.start("profile-a", _config())
    assert (
        store.complete_browser_auth(
            "profile-a", fresh["auth_session_id"], fresh["state"], token
        )
        == token
    )
    with pytest.raises(PeepsAuthError, match="invalid or expired") as replayed:
        store.complete_browser_auth(
            "profile-a", fresh["auth_session_id"], fresh["state"], token
        )
    assert replayed.value.code == "unknown_auth_session"


def test_start_replaces_prior_pending_session_for_profile():
    store = PeepsVoiceAuthSessionStore()
    first = store.start("profile-a", _config())
    second = store.start("profile-a", _config())
    token = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300})

    with pytest.raises(PeepsAuthError, match="invalid or expired") as superseded:
        store.complete_browser_auth(
            "profile-a", first["auth_session_id"], first["state"], token
        )
    assert superseded.value.code == "unknown_auth_session"
    assert (
        store.complete_browser_auth(
            "profile-a", second["auth_session_id"], second["state"], token
        )
        == token
    )


@pytest.mark.parametrize(
    ("payload", "expected_key"),
    [
        ({"token": "jwt-token"}, "token"),
        ({"accessToken": "jwt-token"}, "accessToken"),
        ({"access_token": "jwt-token"}, "access_token"),
    ],
)
def test_cognitive_exchange_uses_only_configured_endpoint_and_parses_json_object_shapes(
    payload, expected_key
):
    peeps = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300})
    cognitive = _jwt(
        {"aud": "https://cognitiveservices.azure.com", "exp": time.time() + 300}
    )
    payload = {
        expected_key: cognitive,
        **({} if expected_key == "token" else {"ignored": "value"}),
    }
    calls = []

    def opener(request, timeout):
        calls.append((request.full_url, request.get_header("Authorization"), timeout))
        return _Response(json.dumps(payload).encode())

    provider = PeepsCognitiveTokenProvider(_config(), opener=opener)
    provider.complete(peeps)

    assert provider.token() == cognitive
    assert calls == [
        (
            "https://seastarserviceapp-develop.azurewebsites.net/token/getCognitiveServicesToken",
            f"Bearer {peeps}",
            15,
        )
    ]


def test_cognitive_exchange_parses_json_string_and_bare_token_and_caches_until_leeway():
    current = {"value": 10_000.0}
    peeps = _jwt(
        {"aud": "https://peeps.asgprototype.com/api", "exp": current["value"] + 1_000}
    )
    first = _jwt(
        {
            "aud": "https://cognitiveservices.azure.com",
            "exp": current["value"] + 400,
        }
    )
    second = _jwt(
        {
            "aud": "https://cognitiveservices.azure.com",
            "exp": current["value"] + 500,
        }
    )
    payloads = iter([json.dumps(first).encode(), second.encode()])
    calls = []

    def opener(_request, _timeout):
        calls.append("mint")
        return _Response(next(payloads))

    provider = PeepsCognitiveTokenProvider(_config(), opener=opener, clock=lambda: current["value"])
    provider.complete(peeps)

    assert provider.token() == first
    assert provider.token() == first
    current["value"] += 311
    assert provider.token() == second
    assert calls == ["mint", "mint"]


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        (b"", "empty_cognitive_response"),
        (b"not-a-jwt", "invalid_jwt_shape"),
        (json.dumps({"token": "a", "accessToken": "b"}).encode(), "invalid_cognitive_response_shape"),
        (json.dumps({"token": _jwt({"aud": "https://example.com", "exp": time.time() + 300})}).encode(), "unexpected_cognitive_audience"),
        (json.dumps({"token": _jwt({"aud": "https://cognitiveservices.azure.com", "exp": time.time() - 1})}).encode(), "expired_cognitive_token"),
    ],
)
def test_cognitive_exchange_rejects_invalid_responses(payload, code):
    peeps = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300})
    provider = PeepsCognitiveTokenProvider(
        _config(), opener=lambda *_args, **_kwargs: _Response(payload)
    )
    provider.complete(peeps)

    with pytest.raises(PeepsAuthError, match="Peeps") as exc:
        provider.token()
    assert exc.value.code == code


def test_cognitive_exchange_rejects_oversized_connectivity_and_http_failures_without_leaking_tokens(
    caplog,
):
    sentinel = "secret-must-not-leak"
    peeps = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300})

    too_large = _jwt(
        {"aud": "https://cognitiveservices.azure.com", "exp": time.time() + 300}
    ).encode() + b"x" * (128 * 1024)
    provider = PeepsCognitiveTokenProvider(
        _config(), opener=lambda *_args, **_kwargs: _Response(too_large)
    )
    provider.complete(peeps)
    with pytest.raises(PeepsAuthError) as oversized:
        provider.token()
    assert oversized.value.code == "oversized_cognitive_response"

    def offline(_request, _timeout):
        raise urllib.error.URLError("offline")

    provider = PeepsCognitiveTokenProvider(_config(), opener=offline)
    provider.complete(peeps)
    with pytest.raises(PeepsAuthError) as connectivity:
        provider.token()
    assert connectivity.value.code == "cognitive_connectivity"

    def denied(request, _timeout):
        raise urllib.error.HTTPError(request.full_url, 401, sentinel, {}, None)

    provider = PeepsCognitiveTokenProvider(_config(), opener=denied)
    provider.complete(peeps)
    with pytest.raises(PeepsAuthError) as denied_exc:
        provider.token()

    assert denied_exc.value.code == "cognitive_http_error"
    assert sentinel not in str(denied_exc.value)
    assert peeps not in str(denied_exc.value)
    assert sentinel not in caplog.text


def test_provider_rejects_wrong_audience_and_tenant_before_exchange():
    wrong_audience = _jwt({"aud": "https://example.com/api", "exp": time.time() + 300})
    provider = PeepsCognitiveTokenProvider(_config())
    with pytest.raises(PeepsAuthError) as audience:
        provider.complete(wrong_audience)
    assert audience.value.code == "unexpected_peeps_audience"

    strict = PeepsCognitiveTokenProvider(
        _config(authority="https://login.microsoftonline.com/tenant-1234")
    )
    wrong_tenant = _jwt(
        {
            "aud": "https://peeps.asgprototype.com/api",
            "exp": time.time() + 300,
            "tid": "tenant-9999",
        }
    )
    with pytest.raises(PeepsAuthError) as tenant:
        strict.complete(wrong_tenant)
    assert tenant.value.code == "unexpected_tenant"


def test_concurrent_callers_share_one_mint():
    current = {"value": 10_000.0}
    peeps = _jwt(
        {"aud": "https://peeps.asgprototype.com/api", "exp": current["value"] + 1_000}
    )
    cognitive = _jwt(
        {
            "aud": "https://cognitiveservices.azure.com",
            "exp": current["value"] + 1_000,
        }
    )
    calls = []
    gate = threading.Event()

    def opener(_request, _timeout):
        calls.append("mint")
        gate.wait(timeout=2.0)
        return _Response(json.dumps({"accessToken": cognitive}).encode())

    provider = PeepsCognitiveTokenProvider(_config(), opener=opener, clock=lambda: current["value"])
    provider.complete(peeps)

    results = []

    def worker():
        results.append(provider.token())

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for thread in threads:
        thread.start()
    gate.set()
    for thread in threads:
        thread.join(timeout=2.0)

    assert results == [cognitive, cognitive]
    assert calls == ["mint"]


def test_cancel_clears_pending_session():
    store = PeepsVoiceAuthSessionStore()
    session = store.start("profile-a", _config())
    assert store.cancel("profile-a", session["auth_session_id"]) is True

    with pytest.raises(PeepsAuthError, match="invalid or expired") as exc:
        store.complete_browser_auth(
            "profile-a",
            session["auth_session_id"],
            session["state"],
            _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300}),
        )
    assert exc.value.code == "unknown_auth_session"
