import base64
import hashlib
import json
import time
import urllib.error

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from tui_gateway.peeps_voice_auth import (
    COGNITIVE_AUDIENCE,
    PEEPS_CLIENT_ID,
    PeepsAuthBinding,
    PeepsAuthError,
    PeepsCognitiveTokenProvider,
    PeepsVoiceAuthConfig,
    PeepsVoiceAuthSessionStore,
)


def _jwt(payload):
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return f"header.{body}.signature"


def _config(**overrides):
    return PeepsVoiceAuthConfig.from_dict({"enabled": True, **overrides})


class _Response:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit=-1):
        return self.payload


def _binding(profile="/tmp/profile", session=None, session_id="runtime", transport=None):
    return PeepsAuthBinding.create(profile, session or object(), session_id, transport or object())


class _AuthenticatedTransport:
    def __init__(self, user_id):
        self.auth_identity = {"provider": "oauth", "user_id": user_id}


def _seal(started, token):
    remote = X25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(started["public_key"] + "=="))
    ephemeral = X25519PrivateKey.generate()
    aad = f'{started["auth_session_id"]}:{started["state"]}'.encode()
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=aad, info=b"hermes-peeps-voice-auth-v1").derive(ephemeral.exchange(remote))
    nonce = b"n" * 12
    encrypted = AESGCM(key).encrypt(nonce, token.encode(), aad)
    encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=").decode()
    return {
        "version": 1,
        "ephemeral_public_key": encode(ephemeral.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)),
        "nonce": encode(nonce),
        "ciphertext": encode(encrypted[:-16]),
        "tag": encode(encrypted[-16:]),
    }


def _main_capability(secret=b"m" * 32, handle=None):
    handle = handle or base64.urlsafe_b64encode(b"h" * 32).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(secret).digest()).rstrip(b"=").decode()
    proof = base64.urlsafe_b64encode(secret).rstrip(b"=").decode()
    return handle, challenge, proof


def test_config_pins_every_identity_value_and_allows_only_timeout():
    config = _config(timeout_seconds=12)
    assert config.client_id == PEEPS_CLIENT_ID
    assert config.timeout_seconds == 12
    for field, value in {
        "client_id": "attacker",
        "authority": "https://login.microsoftonline.com/common",
        "scope": "https://example.com/access",
        "redirect_uri": "https://localhost:8081/",
        "cognitive_token_url": "https://example.com/token",
        "extra": "no",
    }.items():
        with pytest.raises(PeepsAuthError):
            _config(**{field: value})


def test_pending_generation_is_bound_by_object_identity_and_supersedes_only_same_binding():
    store = PeepsVoiceAuthSessionStore()
    session, transport = object(), object()
    binding = _binding(session=session, transport=transport)
    handle, challenge, _proof = _main_capability()
    first = store.start(binding, _config(), main_handle=handle, main_challenge=challenge)
    other_transport = store.start(
        _binding(session=session, transport=object()),
        _config(),
        main_handle=_main_capability(handle=base64.urlsafe_b64encode(b"i" * 32).rstrip(b"=").decode())[0],
        main_challenge=challenge,
    )
    second = store.start(binding, _config(), main_handle=handle, main_challenge=challenge)
    assert first["auth_session_id"] != second["auth_session_id"]
    assert other_transport["auth_session_id"]
    assert store.cancel(_binding(session=session, transport=transport), first["auth_session_id"]) is False
    assert store.cancel(binding, second["auth_session_id"]) is True


def test_envelope_decrypts_once_exchanges_immediately_and_ready_provider_is_one_use():
    store = PeepsVoiceAuthSessionStore()
    binding = _binding()
    handle, challenge, proof = _main_capability()
    started = store.start(binding, _config(), main_handle=handle, main_challenge=challenge)
    store.claim(binding, started["auth_session_id"], main_handle=handle, native_main_proof=proof)
    peeps = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300})
    cognitive = _jwt({"aud": COGNITIVE_AUDIENCE, "exp": time.time() + 300})
    calls = []

    def opener(request, timeout):
        calls.append((request.get_header("Authorization"), timeout))
        return _Response(json.dumps({"accessToken": cognitive}).encode())

    envelope = _seal(started, peeps)
    store.complete(binding, started["auth_session_id"], started["state"], envelope, _config(), opener=opener)
    assert calls == [(f"Bearer {peeps}", 15)]
    provider = store.consume_ready(binding, started["auth_session_id"])
    assert provider is not None
    assert provider.token() == cognitive
    with pytest.raises(PeepsAuthError, match="already consumed"):
        provider.token()
    assert store.consume_ready(binding, started["auth_session_id"]) is None
    with pytest.raises(PeepsAuthError):
        store.complete(binding, started["auth_session_id"], started["state"], envelope, _config(), opener=opener)


def test_claim_requires_one_time_native_main_proof_and_preserves_original_retry_binding():
    store = PeepsVoiceAuthSessionStore()
    session, original_transport, companion_transport = object(), object(), object()
    original = _binding(session=session, transport=original_transport)
    companion = _binding(session=session, transport=companion_transport)
    handle, challenge, proof = _main_capability()
    started = store.start(original, _config(), main_handle=handle, main_challenge=challenge)

    for wrong in (
        _binding(profile="/tmp/other", session=session),
        _binding(session=object()),
        _binding(session=session, session_id="other"),
    ):
        with pytest.raises(PeepsAuthError):
            store.claim(wrong, started["auth_session_id"], main_handle=handle, native_main_proof=proof)

    for invalid in (
        {},
        {"main_handle": handle, "native_main_proof": ""},
        {"main_handle": handle, "native_main_proof": _main_capability(b"w" * 32)[2]},
        {"main_handle": "x" * 43, "native_main_proof": proof},
    ):
        with pytest.raises(PeepsAuthError):
            store.claim(companion, started["auth_session_id"], **invalid)

    claimed = store.claim(companion, started["auth_session_id"], main_handle=handle, native_main_proof=proof)
    assert claimed == started
    with pytest.raises(PeepsAuthError):
        store.claim(companion, started["auth_session_id"], main_handle=handle, native_main_proof=proof)

    peeps = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300})
    cognitive = _jwt({"aud": COGNITIVE_AUDIENCE, "exp": time.time() + 300})
    store.complete(
        companion,
        started["auth_session_id"],
        started["state"],
        _seal(started, peeps),
        _config(),
        opener=lambda *_: _Response(json.dumps({"accessToken": cognitive}).encode()),
    )

    assert store.consume_ready(companion, started["auth_session_id"]) is None
    assert store.consume_ready(original, started["auth_session_id"]) is not None


def test_claimed_companion_can_cancel_without_leaking_pending_capacity():
    store = PeepsVoiceAuthSessionStore(max_pending=1)
    session = object()
    original = _binding(session=session, transport=object())
    companion = _binding(session=session, transport=object())
    handle, challenge, proof = _main_capability()
    config = _config()
    assert config is not None
    started = store.start(original, config, main_handle=handle, main_challenge=challenge)
    store.claim(
        companion,
        started["auth_session_id"],
        main_handle=handle,
        native_main_proof=proof,
    )

    assert store.cancel(companion, started["auth_session_id"]) is True
    replacement = store.start(original, config, main_handle=handle, main_challenge=challenge)
    assert replacement["auth_session_id"] != started["auth_session_id"]


def test_claim_rejects_a_companion_authenticated_as_a_different_remote_user():
    store = PeepsVoiceAuthSessionStore()
    session = object()
    original = _binding(session=session, transport=_AuthenticatedTransport("user-a"))
    handle, challenge, proof = _main_capability()
    started = store.start(original, _config(), main_handle=handle, main_challenge=challenge)

    with pytest.raises(PeepsAuthError):
        store.claim(
            _binding(session=session, transport=_AuthenticatedTransport("user-b")),
            started["auth_session_id"],
            main_handle=handle,
            native_main_proof=proof,
        )

    assert store.claim(
        _binding(session=session, transport=_AuthenticatedTransport("user-a")),
        started["auth_session_id"],
        main_handle=handle,
        native_main_proof=proof,
    ) == started


def test_cross_transport_session_profile_and_rebound_session_cannot_complete_or_consume():
    store = PeepsVoiceAuthSessionStore()
    session, transport = object(), object()
    binding = _binding(session=session, transport=transport)
    handle, challenge, proof = _main_capability()
    started = store.start(binding, _config(), main_handle=handle, main_challenge=challenge)
    store.claim(binding, started["auth_session_id"], main_handle=handle, native_main_proof=proof)
    token = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300})
    for wrong in (
        _binding(profile="/tmp/other", session=session, transport=transport),
        _binding(session=object(), transport=transport),
        _binding(session=session, session_id="other", transport=transport),
        _binding(session=session, transport=object()),
    ):
        with pytest.raises(PeepsAuthError):
            store.complete(wrong, started["auth_session_id"], started["state"], _seal(started, token), _config())
    assert store.cancel(binding, started["auth_session_id"])


def test_exact_audiences_and_sanitized_exchange_failures(caplog):
    sentinel = "bearer-sentinel"
    wrong = _jwt({"aud": "https://peeps.asgprototype.com/api/", "exp": time.time() + 300})
    with pytest.raises(PeepsAuthError) as audience:
        PeepsCognitiveTokenProvider.exchange(_config(), wrong, opener=lambda *_: None)
    assert audience.value.code == "unexpected_peeps_audience"

    peeps = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300})

    def denied(request, _timeout):
        raise urllib.error.HTTPError(request.full_url, 401, sentinel, {}, None)

    with pytest.raises(PeepsAuthError) as denied_error:
        PeepsCognitiveTokenProvider.exchange(_config(), peeps, opener=denied)
    assert denied_error.value.status == 401
    assert sentinel not in str(denied_error.value)
    assert peeps not in caplog.text


def test_default_exchange_opener_installs_no_redirect_handler(monkeypatch):
    import tui_gateway.peeps_voice_auth as module

    captured = {}

    class Opener:
        def open(self, _request, timeout):
            captured["timeout"] = timeout
            raise urllib.error.HTTPError("url", 302, "redirect", {"Location": "https://evil"}, None)

    def build(*handlers):
        captured["handlers"] = handlers
        return Opener()

    monkeypatch.setattr(module.urllib.request, "build_opener", build)
    peeps = _jwt({"aud": "https://peeps.asgprototype.com/api", "exp": time.time() + 300})
    with pytest.raises(PeepsAuthError) as exc:
        PeepsCognitiveTokenProvider.exchange(_config(), peeps)
    assert exc.value.status == 302
    assert any(isinstance(handler, module._NoRedirect) for handler in captured["handlers"])
