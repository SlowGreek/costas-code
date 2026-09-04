"""One-use, session-bound Peeps fallback for Azure Realtime voice."""

from __future__ import annotations

import base64
import json
import logging
import secrets
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

logger = logging.getLogger(__name__)

PEEPS_CLIENT_ID = "b6ca153a-37a1-4f59-ad95-c4e30313c64b"
PEEPS_AUTHORITY = "https://login.microsoftonline.com/organizations"
PEEPS_SCOPE = "https://peeps.asgprototype.com/api/access-as-user"
PEEPS_AUDIENCE = "https://peeps.asgprototype.com/api"
PEEPS_REDIRECT_URI = "https://localhost:8080/"
COGNITIVE_TOKEN_URL = "https://seastarserviceapp-develop.azurewebsites.net/token/getCognitiveServicesToken"
COGNITIVE_AUDIENCE = "https://cognitiveservices.azure.com"

_EXCHANGE_TIMEOUT_SECONDS = 15
_MAX_PENDING = 32
_MAX_RESPONSE_BYTES = 128 * 1024
_MAX_ENVELOPE_FIELD = 16 * 1024


class PeepsAuthError(RuntimeError):
    """A sanitized Peeps authentication failure."""

    def __init__(self, message: str, *, code: str = "peeps_auth_failed", status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _b64url_decode(value: str, *, code: str) -> bytes:
    if not isinstance(value, str) or not value or len(value) > _MAX_ENVELOPE_FIELD:
        raise PeepsAuthError("Peeps authorization envelope is invalid", code=code)
    try:
        return base64.b64decode(value + "=" * (-len(value) % 4), altchars=b"-_", validate=True)
    except (ValueError, TypeError) as exc:
        raise PeepsAuthError("Peeps authorization envelope is invalid", code=code) from exc


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode_jwt_payload(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise PeepsAuthError("Peeps returned an invalid token", code="invalid_jwt_shape")
    try:
        data = json.loads(_b64url_decode(parts[1], code="invalid_jwt_payload").decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PeepsAuthError("Peeps returned an invalid token", code="invalid_jwt_payload") from exc
    if not isinstance(data, dict):
        raise PeepsAuthError("Peeps returned an invalid token", code="invalid_jwt_payload")
    return data


def _validate_token(token: str, *, audience: str, expired_code: str, now: float) -> float:
    claims = _decode_jwt_payload(token)
    try:
        expiry = float(claims["exp"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PeepsAuthError("Peeps returned an invalid token", code=expired_code) from exc
    if expiry <= now:
        raise PeepsAuthError("Peeps returned an expired token", code=expired_code)
    if claims.get("aud") != audience:
        raise PeepsAuthError(
            "Peeps returned a token for an unexpected audience",
            code="unexpected_peeps_audience" if audience == PEEPS_AUDIENCE else "unexpected_cognitive_audience",
        )
    return expiry


@dataclass(frozen=True)
class PeepsVoiceAuthConfig:
    client_id: str = PEEPS_CLIENT_ID
    authority: str = PEEPS_AUTHORITY
    scope: str = PEEPS_SCOPE
    redirect_uri: str = PEEPS_REDIRECT_URI
    cognitive_token_url: str = COGNITIVE_TOKEN_URL
    timeout_seconds: int = 180

    @property
    def expected_peeps_audiences(self) -> set[str]:
        return {PEEPS_AUDIENCE}

    @property
    def expected_tenant(self) -> None:
        return None

    @classmethod
    def from_dict(cls, value: dict[str, Any] | None) -> "PeepsVoiceAuthConfig | None":
        value = value if isinstance(value, dict) else {}
        if not value.get("enabled"):
            return None
        pinned = {
            "client_id": PEEPS_CLIENT_ID,
            "authority": PEEPS_AUTHORITY,
            "scope": PEEPS_SCOPE,
            "redirect_uri": PEEPS_REDIRECT_URI,
            "cognitive_token_url": COGNITIVE_TOKEN_URL,
        }
        for key, expected in pinned.items():
            if key in value and value[key] != expected:
                raise PeepsAuthError(f"Peeps {key} is fixed", code=f"invalid_{key}")
        unknown = set(value) - {"enabled", "timeout_seconds", *pinned}
        if unknown:
            raise PeepsAuthError("Peeps voice fallback configuration contains unsupported fields", code="invalid_config")
        timeout = value.get("timeout_seconds", 180)
        if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 300:
            raise PeepsAuthError("Peeps timeout must be between 1 and 300 seconds", code="invalid_timeout_seconds")
        return cls(timeout_seconds=timeout)


@dataclass(frozen=True)
class PeepsAuthBinding:
    profile_home: str
    runtime_session: object
    runtime_session_id: str
    transport: object

    @classmethod
    def create(cls, profile_home: str | Path, runtime_session: object, runtime_session_id: str, transport: object) -> "PeepsAuthBinding":
        return cls(str(Path(profile_home).expanduser().resolve()), runtime_session, runtime_session_id, transport)


def _same_binding(left: PeepsAuthBinding, right: PeepsAuthBinding) -> bool:
    return (
        left.profile_home == right.profile_home
        and left.runtime_session is right.runtime_session
        and left.runtime_session_id == right.runtime_session_id
        and left.transport is right.transport
    )


@dataclass
class _Pending:
    binding: PeepsAuthBinding
    expires: float
    state: str
    private_key: X25519PrivateKey | None


@dataclass
class _Ready:
    binding: PeepsAuthBinding
    expires: float
    provider: "PeepsCognitiveTokenProvider"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


def _default_open(request: urllib.request.Request, timeout: int):
    return urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout)


class PeepsCognitiveTokenProvider:
    """A one-use Cognitive Services token. It never retains a Peeps bearer."""

    def __init__(self, cognitive_token: str, *, expiry: float, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._expiry = expiry
        self._lock = threading.Lock()
        self._token = cognitive_token

    @classmethod
    def exchange(
        cls,
        config: PeepsVoiceAuthConfig,
        peeps_token: str,
        *,
        opener: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> "PeepsCognitiveTokenProvider":
        now = clock()
        _validate_token(peeps_token, audience=PEEPS_AUDIENCE, expired_code="expired_peeps_token", now=now)
        request = urllib.request.Request(
            config.cognitive_token_url,
            headers={"Authorization": f"Bearer {peeps_token}"},
            method="GET",
        )
        try:
            with (opener or _default_open)(request, _EXCHANGE_TIMEOUT_SECONDS) as response:
                raw = response.read(_MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise PeepsAuthError(
                f"Peeps could not obtain a Cognitive Services credential (HTTP {exc.code})",
                code="cognitive_http_error",
                status=exc.code,
            ) from exc
        except urllib.error.URLError as exc:
            raise PeepsAuthError("Peeps could not reach the Cognitive Services token endpoint", code="cognitive_connectivity") from exc
        except PeepsAuthError:
            raise
        except Exception as exc:
            raise PeepsAuthError("Peeps could not obtain a Cognitive Services credential", code="cognitive_exchange_failed") from exc
        if len(raw) > _MAX_RESPONSE_BYTES:
            raise PeepsAuthError("Peeps returned an oversized Cognitive Services credential", code="oversized_cognitive_response")
        cognitive = cls._parse_token(raw)
        expiry = _validate_token(cognitive, audience=COGNITIVE_AUDIENCE, expired_code="expired_cognitive_token", now=now)
        logger.debug("Peeps Cognitive Services exchange status=ok")
        return cls(cognitive, expiry=expiry, clock=clock)

    def token(self) -> str:
        with self._lock:
            token, self._token = self._token, ""
            if not token:
                raise PeepsAuthError("Peeps credential was already consumed", code="credential_consumed")
            if self._expiry <= self._clock():
                raise PeepsAuthError("Peeps credential expired", code="expired_cognitive_token")
            return token

    @staticmethod
    def _parse_token(raw: bytes) -> str:
        try:
            decoded = raw.decode("utf-8", errors="strict").strip()
        except UnicodeDecodeError as exc:
            raise PeepsAuthError("Peeps returned an invalid Cognitive Services credential", code="invalid_cognitive_response_shape") from exc
        if not decoded:
            raise PeepsAuthError("Peeps returned an invalid Cognitive Services credential", code="empty_cognitive_response")
        try:
            parsed = json.loads(decoded)
        except json.JSONDecodeError:
            parsed = decoded
        if isinstance(parsed, dict):
            values = [str(parsed[key]).strip() for key in ("token", "accessToken", "access_token") if parsed.get(key)]
            if len(values) != 1:
                raise PeepsAuthError("Peeps returned an invalid Cognitive Services credential", code="invalid_cognitive_response_shape")
            token = values[0]
        elif isinstance(parsed, str):
            token = parsed.strip()
        else:
            token = ""
        if not token or any(char.isspace() for char in token):
            raise PeepsAuthError("Peeps returned an invalid Cognitive Services credential", code="invalid_cognitive_response_shape")
        return token


class PeepsVoiceAuthSessionStore:
    def __init__(self, *, max_pending: int = _MAX_PENDING, monotonic: Callable[[], float] = time.monotonic) -> None:
        self._lock = threading.Lock()
        self._max_pending = max_pending
        self._monotonic = monotonic
        self._pending: dict[str, _Pending] = {}
        self._ready: dict[str, _Ready] = {}

    def _prune_locked(self, now: float) -> None:
        for table in (self._pending, self._ready):
            for key in [key for key, value in table.items() if value.expires <= now]:
                removed = table.pop(key)
                if isinstance(removed, _Pending):
                    removed.private_key = None

    def start(self, binding: PeepsAuthBinding, config: PeepsVoiceAuthConfig) -> dict[str, Any]:
        now = self._monotonic()
        private = X25519PrivateKey.generate()
        auth_id, state = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        with self._lock:
            self._prune_locked(now)
            for key, value in list(self._pending.items()):
                if _same_binding(value.binding, binding):
                    value.private_key = None
                    self._pending.pop(key)
            for key, value in list(self._ready.items()):
                if _same_binding(value.binding, binding):
                    self._ready.pop(key)
            if len(self._pending) >= self._max_pending:
                raise PeepsAuthError("Too many Peeps authorization sessions are pending", code="too_many_pending_sessions")
            self._pending[auth_id] = _Pending(binding, now + config.timeout_seconds, state, private)
        public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        return {"auth_session_id": auth_id, "state": state, "public_key": _b64url_encode(public)}

    def _take_pending(self, binding: PeepsAuthBinding, auth_id: str, state: str) -> _Pending:
        with self._lock:
            self._prune_locked(self._monotonic())
            pending = self._pending.get(auth_id)
            if pending is None or pending.state != state or not _same_binding(pending.binding, binding):
                raise PeepsAuthError("Peeps authorization session is invalid or expired", code="invalid_auth_session")
            self._pending.pop(auth_id)
            return pending

    def complete(
        self,
        binding: PeepsAuthBinding,
        auth_id: str,
        state: str,
        envelope: dict[str, Any],
        config: PeepsVoiceAuthConfig,
        *,
        opener: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        pending = self._take_pending(binding, auth_id, state)
        private, pending.private_key = pending.private_key, None
        try:
            if private is None or set(envelope) != {"version", "ephemeral_public_key", "nonce", "ciphertext", "tag"} or envelope.get("version") != 1:
                raise PeepsAuthError("Peeps authorization envelope is invalid", code="invalid_envelope")
            ephemeral = _b64url_decode(envelope["ephemeral_public_key"], code="invalid_envelope")
            nonce = _b64url_decode(envelope["nonce"], code="invalid_envelope")
            ciphertext = _b64url_decode(envelope["ciphertext"], code="invalid_envelope")
            tag = _b64url_decode(envelope["tag"], code="invalid_envelope")
            if len(ephemeral) != 32 or len(nonce) != 12 or len(tag) != 16 or not ciphertext:
                raise PeepsAuthError("Peeps authorization envelope is invalid", code="invalid_envelope")
            shared = private.exchange(X25519PublicKey.from_public_bytes(ephemeral))
            aad = f"{auth_id}:{state}".encode()
            key = HKDF(algorithm=hashes.SHA256(), length=32, salt=aad, info=b"hermes-peeps-voice-auth-v1").derive(shared)
            plaintext = bytearray(AESGCM(key).decrypt(nonce, ciphertext + tag, aad))
            try:
                peeps_token = plaintext.decode("utf-8")
                provider = PeepsCognitiveTokenProvider.exchange(config, peeps_token, opener=opener, clock=clock)
            finally:
                plaintext[:] = b"\0" * len(plaintext)
                peeps_token = ""
        except PeepsAuthError:
            raise
        except Exception as exc:
            raise PeepsAuthError("Peeps authorization envelope is invalid", code="invalid_envelope") from exc
        with self._lock:
            self._ready[auth_id] = _Ready(binding, pending.expires, provider)

    def consume_ready(self, binding: PeepsAuthBinding, auth_id: str) -> PeepsCognitiveTokenProvider | None:
        with self._lock:
            self._prune_locked(self._monotonic())
            ready = self._ready.get(auth_id)
            if ready is None or not _same_binding(ready.binding, binding):
                return None
            self._ready.pop(auth_id)
            return ready.provider

    def cancel(self, binding: PeepsAuthBinding, auth_id: str) -> bool:
        with self._lock:
            pending = self._pending.get(auth_id)
            ready = self._ready.get(auth_id)
            target = pending or ready
            if target is None or not _same_binding(target.binding, binding):
                return False
            self._pending.pop(auth_id, None)
            self._ready.pop(auth_id, None)
            if pending is not None:
                pending.private_key = None
            return True
