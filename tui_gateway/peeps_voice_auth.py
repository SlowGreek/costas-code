"""Memory-only Peeps bearer exchange for Azure Realtime voice."""

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
from typing import Any, Callable
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_CACHE_LEEWAY_SECONDS = 90
_COGNITIVE_EXCHANGE_TIMEOUT_SECONDS = 15
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
_MAX_PENDING_AUTH_SESSIONS = 32
_MAX_RESPONSE_BYTES = 128 * 1024
_TENANT_WILDCARDS = {"common", "consumers", "organizations"}


class PeepsAuthError(RuntimeError):
    """A sanitized Peeps authentication failure."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "peeps_auth_failed",
        status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _decode_jwt_payload(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise PeepsAuthError(
            "Peeps returned an invalid token", code="invalid_jwt_shape"
        )
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        decoded = base64.urlsafe_b64decode(payload.encode("ascii"))
        data = json.loads(decoded.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise PeepsAuthError(
            "Peeps returned an invalid token", code="invalid_jwt_payload"
        ) from exc
    if not isinstance(data, dict):
        raise PeepsAuthError(
            "Peeps returned an invalid token", code="invalid_jwt_payload"
        )
    return data


def _coerce_audiences(value: Any) -> set[str]:
    if isinstance(value, str):
        return {value.strip()} if value.strip() else set()
    if isinstance(value, list):
        return {str(item).strip() for item in value if str(item).strip()}
    return set()


def _normalize_audience(value: str) -> str:
    return value.rstrip("/")


def _expected_scope_audiences(scope: str) -> set[str]:
    scope_value = str(scope or "").strip().split()[0]
    if not scope_value:
        return set()
    expected = {_normalize_audience(scope_value)}
    if scope_value.endswith("/.default"):
        expected.add(_normalize_audience(scope_value[: -len("/.default")]))
    for suffix in ("/access-as-user", "/access_as_user"):
        if scope_value.endswith(suffix):
            expected.add(_normalize_audience(scope_value[: -len(suffix)]))
    return {value for value in expected if value}


def _expected_tenant(authority: str) -> str | None:
    path = urlparse(authority).path.strip("/")
    tenant = path.split("/")[-1].strip() if path else ""
    return None if not tenant or tenant.lower() in _TENANT_WILDCARDS else tenant


def _expiry_from_claims(
    claims: dict[str, Any], *, code: str, now: float | None = None
) -> float:
    try:
        expiry = float(claims["exp"])
    except (KeyError, TypeError, ValueError) as exc:
        raise PeepsAuthError("Peeps returned an invalid token", code=code) from exc
    if expiry <= (time.time() if now is None else now):
        raise PeepsAuthError("Peeps returned an expired token", code=code)
    return expiry


def _validate_token_claims(
    token: str,
    *,
    expected_audiences: set[str],
    expected_tenant: str | None,
    audience_code: str,
    expired_code: str,
    now: float | None = None,
) -> tuple[dict[str, Any], float]:
    claims = _decode_jwt_payload(token)
    expiry = _expiry_from_claims(claims, code=expired_code, now=now)
    audiences = {
        _normalize_audience(candidate)
        for candidate in _coerce_audiences(claims.get("aud"))
    }
    if not audiences or not audiences.intersection(expected_audiences):
        raise PeepsAuthError(
            "Peeps returned a token for an unexpected audience",
            code=audience_code,
        )
    if expected_tenant is not None:
        tenant_id = str(claims.get("tid") or "").strip()
        if tenant_id != expected_tenant:
            raise PeepsAuthError(
                "Peeps returned a token for an unexpected tenant",
                code="unexpected_tenant",
            )
    return claims, expiry


@dataclass(frozen=True)
class PeepsVoiceAuthConfig:
    client_id: str
    authority: str
    scope: str
    redirect_uri: str
    cognitive_token_url: str
    timeout_seconds: int = 180

    @property
    def expected_peeps_audiences(self) -> set[str]:
        return _expected_scope_audiences(self.scope)

    @property
    def expected_tenant(self) -> str | None:
        return _expected_tenant(self.authority)

    @classmethod
    def from_dict(cls, value: dict[str, Any] | None) -> "PeepsVoiceAuthConfig | None":
        value = value if isinstance(value, dict) else {}
        if not value.get("enabled"):
            return None

        required = {
            key: str(value.get(key) or "").strip()
            for key in (
                "client_id",
                "authority",
                "scope",
                "redirect_uri",
                "cognitive_token_url",
            )
        }
        if not all(required.values()):
            raise PeepsAuthError(
                "Peeps voice fallback configuration is incomplete",
                code="config_incomplete",
            )

        authority = urlparse(required["authority"])
        if authority.scheme != "https" or not authority.netloc or not authority.path.strip("/"):
            raise PeepsAuthError(
                "Peeps authority must be an HTTPS tenant URL",
                code="invalid_authority",
            )

        scope = required["scope"].split()
        if len(scope) != 1 or not (
            scope[0].startswith("https://") or scope[0].startswith("api://")
        ):
            raise PeepsAuthError(
                "Peeps scope must be one HTTPS or api:// scope",
                code="invalid_scope",
            )

        redirect = urlparse(required["redirect_uri"])
        if (
            redirect.scheme != "https"
            or redirect.hostname not in _LOOPBACK_HOSTS
            or redirect.port != 8080
            or redirect.path != "/"
            or redirect.params
            or redirect.query
            or redirect.fragment
        ):
            raise PeepsAuthError(
                "Peeps redirect must be https://localhost:8080/",
                code="invalid_redirect_uri",
            )

        endpoint = urlparse(required["cognitive_token_url"])
        if (
            endpoint.scheme != "https"
            or not endpoint.netloc
            or not endpoint.path
            or endpoint.params
            or endpoint.query
            or endpoint.fragment
        ):
            raise PeepsAuthError(
                "Peeps Cognitive token endpoint must be an HTTPS URL",
                code="invalid_cognitive_token_url",
            )

        try:
            timeout_seconds = int(value.get("timeout_seconds", 180))
        except (TypeError, ValueError) as exc:
            raise PeepsAuthError(
                "Peeps timeout must be an integer number of seconds",
                code="invalid_timeout_seconds",
            ) from exc
        if timeout_seconds < 1 or timeout_seconds > 300:
            raise PeepsAuthError(
                "Peeps timeout must be between 1 and 300 seconds",
                code="invalid_timeout_seconds",
            )

        return cls(
            client_id=required["client_id"],
            authority=required["authority"],
            scope=scope[0],
            redirect_uri=required["redirect_uri"],
            cognitive_token_url=required["cognitive_token_url"],
            timeout_seconds=timeout_seconds,
        )


@dataclass(frozen=True)
class _PendingAuthSession:
    expires_monotonic: float
    profile_key: str
    state: str


class PeepsVoiceAuthSessionStore:
    def __init__(
        self,
        *,
        max_pending: int = _MAX_PENDING_AUTH_SESSIONS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._active_by_profile: dict[str, str] = {}
        self._lock = threading.Lock()
        self._max_pending = max_pending
        self._monotonic = monotonic
        self._sessions: dict[str, _PendingAuthSession] = {}

    def _prune_locked(self, now: float) -> None:
        expired = [
            auth_session_id
            for auth_session_id, session in self._sessions.items()
            if session.expires_monotonic <= now
        ]
        for auth_session_id in expired:
            session = self._sessions.pop(auth_session_id, None)
            if (
                session is not None
                and self._active_by_profile.get(session.profile_key) == auth_session_id
            ):
                self._active_by_profile.pop(session.profile_key, None)

    def start(self, profile_key: str, config: PeepsVoiceAuthConfig) -> dict[str, Any]:
        now = self._monotonic()
        auth_session_id = secrets.token_urlsafe(24)
        state = secrets.token_urlsafe(24)
        with self._lock:
            self._prune_locked(now)
            previous = self._active_by_profile.get(profile_key)
            if previous:
                self._sessions.pop(previous, None)
            if len(self._sessions) >= self._max_pending:
                raise PeepsAuthError(
                    "Too many Peeps authorization sessions are pending",
                    code="too_many_pending_sessions",
                )
            self._sessions[auth_session_id] = _PendingAuthSession(
                expires_monotonic=now + config.timeout_seconds,
                profile_key=profile_key,
                state=state,
            )
            self._active_by_profile[profile_key] = auth_session_id
        return {"auth_session_id": auth_session_id, "state": state}

    def complete_browser_auth(
        self, profile_key: str, auth_session_id: str, state: str, peeps_token: str
    ) -> str:
        now = self._monotonic()
        with self._lock:
            self._prune_locked(now)
            pending = self._sessions.get(auth_session_id)
            if pending is None:
                raise PeepsAuthError(
                    "Peeps authorization session is invalid or expired",
                    code="unknown_auth_session",
                )
            if pending.profile_key != profile_key:
                raise PeepsAuthError(
                    "Peeps authorization session is invalid or expired",
                    code="wrong_profile",
                )
            if self._active_by_profile.get(profile_key) != auth_session_id:
                raise PeepsAuthError(
                    "Peeps authorization session is invalid or expired",
                    code="superseded_auth_session",
                )
            if pending.state != state:
                raise PeepsAuthError(
                    "Peeps authorization session is invalid or expired",
                    code="wrong_state",
                )
            self._sessions.pop(auth_session_id, None)
            self._active_by_profile.pop(profile_key, None)

        token = str(peeps_token or "").strip()
        if not token:
            raise PeepsAuthError(
                "Peeps authorization did not return a token",
                code="missing_peeps_token",
            )
        return token

    def complete(self, profile_key: str, auth_session_id: str, state: str, token: str) -> str:
        return self.complete_browser_auth(profile_key, auth_session_id, state, token)

    def cancel(self, profile_key: str, auth_session_id: str) -> bool:
        with self._lock:
            pending = self._sessions.get(auth_session_id)
            if pending is None or pending.profile_key != profile_key:
                return False
            self._sessions.pop(auth_session_id, None)
            if self._active_by_profile.get(profile_key) == auth_session_id:
                self._active_by_profile.pop(profile_key, None)
            return True


class PeepsCognitiveTokenProvider:
    def __init__(
        self,
        config: PeepsVoiceAuthConfig,
        *,
        opener: Callable[..., Any] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.config = config
        self._clock = clock
        self._lock = threading.Lock()
        self._opener = opener or urllib.request.urlopen
        self._peeps_expiry = 0.0
        self._peeps_token = ""
        self._cognitive_expiry = 0.0
        self._cognitive_token = ""

    def complete(self, peeps_token: str) -> None:
        now = self._clock()
        _validate_token_claims(
            str(peeps_token or "").strip(),
            expected_audiences={
                _normalize_audience(value)
                for value in self.config.expected_peeps_audiences
            },
            expected_tenant=self.config.expected_tenant,
            audience_code="unexpected_peeps_audience",
            expired_code="expired_peeps_token",
            now=now,
        )
        claims = _decode_jwt_payload(peeps_token)
        expiry = _expiry_from_claims(claims, code="expired_peeps_token", now=now)
        with self._lock:
            self._peeps_token = str(peeps_token or "").strip()
            self._peeps_expiry = expiry
            self._cognitive_token = ""
            self._cognitive_expiry = 0.0

    def invalidate(self) -> None:
        with self._lock:
            self._cognitive_token = ""
            self._cognitive_expiry = 0.0

    def token(self) -> str:
        with self._lock:
            now = self._clock()
            if self._cognitive_token and self._cognitive_expiry - _CACHE_LEEWAY_SECONDS > now:
                return self._cognitive_token
            if not self._peeps_token:
                raise PeepsAuthError(
                    "Peeps authorization has not completed",
                    code="authorization_required",
                )
            if self._peeps_expiry - _CACHE_LEEWAY_SECONDS <= now:
                raise PeepsAuthError(
                    "Peeps authorization has expired",
                    code="expired_peeps_token",
                )
            token = self._peeps_token
            cognitive_token = self._exchange_cognitive_token(token)
            _, expiry = _validate_token_claims(
                cognitive_token,
                expected_audiences={
                    "https://cognitiveservices.azure.com",
                    "https://cognitiveservices.azure.com/",
                },
                expected_tenant=self.config.expected_tenant,
                audience_code="unexpected_cognitive_audience",
                expired_code="expired_cognitive_token",
                now=now,
            )
            self._cognitive_token = cognitive_token
            self._cognitive_expiry = expiry
            logger.debug(
                "Peeps minted Cognitive Services token exp=%s status=ok",
                int(expiry),
            )
            return cognitive_token

    def _exchange_cognitive_token(self, peeps_token: str) -> str:
        request = urllib.request.Request(
            self.config.cognitive_token_url,
            headers={"Authorization": f"Bearer {peeps_token}"},
            method="GET",
        )
        try:
            with self._opener(request, _COGNITIVE_EXCHANGE_TIMEOUT_SECONDS) as response:
                raw = response.read(_MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise PeepsAuthError(
                f"Peeps could not obtain a Cognitive Services credential (HTTP {exc.code})",
                code="cognitive_http_error",
                status=exc.code,
            ) from exc
        except urllib.error.URLError as exc:
            raise PeepsAuthError(
                "Peeps could not reach the Cognitive Services token endpoint",
                code="cognitive_connectivity",
            ) from exc
        except Exception as exc:
            raise PeepsAuthError(
                "Peeps could not obtain a Cognitive Services credential",
                code="cognitive_exchange_failed",
            ) from exc

        if len(raw) > _MAX_RESPONSE_BYTES:
            raise PeepsAuthError(
                "Peeps returned an oversized Cognitive Services credential",
                code="oversized_cognitive_response",
            )
        return self._parse_token(raw)

    @staticmethod
    def _parse_token(raw: bytes) -> str:
        decoded = raw.decode("utf-8", errors="strict").strip()
        if not decoded:
            raise PeepsAuthError(
                "Peeps returned an invalid Cognitive Services credential",
                code="empty_cognitive_response",
            )
        try:
            parsed = json.loads(decoded)
        except json.JSONDecodeError:
            parsed = decoded

        token = ""
        if isinstance(parsed, dict):
            found = [
                str(parsed[key]).strip()
                for key in ("token", "accessToken", "access_token")
                if str(parsed.get(key) or "").strip()
            ]
            if len(found) != 1:
                raise PeepsAuthError(
                    "Peeps returned an invalid Cognitive Services credential",
                    code="invalid_cognitive_response_shape",
                )
            token = found[0]
        elif isinstance(parsed, str):
            token = parsed.strip()
        else:
            raise PeepsAuthError(
                "Peeps returned an invalid Cognitive Services credential",
                code="invalid_cognitive_response_shape",
            )

        if not token or any(character.isspace() for character in token):
            raise PeepsAuthError(
                "Peeps returned an invalid Cognitive Services credential",
                code="invalid_cognitive_response_shape",
            )
        return token
