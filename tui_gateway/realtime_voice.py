"""OpenAI Realtime credential exchange for the desktop voice workbench."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable


_OPENAI_REALTIME_BASE_URL = "https://api.openai.com/v1"
_MAX_RESPONSE_BYTES = 128 * 1024


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Reject redirects before urllib can forward the bearer header."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ANN201
        return None


def _default_open(request: urllib.request.Request, *, timeout: int):
    return urllib.request.build_opener(_NoRedirect()).open(request, timeout=timeout)


class RealtimeCredentialError(RuntimeError):
    """The backend could not mint a short-lived browser credential."""

    def __init__(self, message: str, *, kind: str = "credential", status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status


def create_realtime_client_secret(
    *,
    api_key: str,
    model: str,
    voice: str,
    transcription_model: str,
    base_url: str = "",
    opener: Callable[..., Any] | None = None,
    timeout: int = 15,
) -> dict[str, Any]:
    """Mint a short-lived WebRTC credential without exposing the standard key.

    ``base_url`` points at an Azure OpenAI / AI Foundry resource
    (``https://<resource>.openai.azure.com/openai/v1``). Azure exposes the same
    realtime surface as OpenAI and accepts an Entra bearer, so only the host
    changes. The minting host is returned as ``webrtc_url`` because an
    ephemeral secret is only valid against the resource that issued it.
    """
    if not api_key.strip():
        raise RealtimeCredentialError(
            "OpenAI Realtime requires VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY"
        )

    root = (base_url or _OPENAI_REALTIME_BASE_URL).strip().rstrip("/")

    session = {
        "type": "realtime",
        "model": model,
        "audio": {
            "input": {
                "transcription": {"model": transcription_model},
                "turn_detection": {
                    "type": "semantic_vad",
                    "eagerness": "auto",
                    "create_response": True,
                    "interrupt_response": True,
                },
            },
            "output": {"voice": voice},
        },
    }
    request = urllib.request.Request(
        f"{root}/realtime/client_secrets",
        data=json.dumps({"session": session}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    open_request = opener or _default_open

    try:
        with open_request(request, timeout=timeout) as response:
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(raw) > _MAX_RESPONSE_BYTES:
                raise RealtimeCredentialError("OpenAI Realtime credential response was too large")
    except urllib.error.HTTPError as exc:
        raise RealtimeCredentialError(
            f"OpenAI Realtime rejected the credential request (HTTP {exc.code})",
            kind="auth_rejected" if exc.code in (401, 403) else "http",
            status=exc.code,
        ) from exc
    except urllib.error.URLError as exc:
        raise RealtimeCredentialError("Could not reach OpenAI Realtime", kind="connectivity") from exc

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RealtimeCredentialError("OpenAI Realtime returned an invalid credential response") from exc

    secret = str(payload.get("value") or "").strip() if isinstance(payload, dict) else ""
    if not secret:
        raise RealtimeCredentialError("OpenAI Realtime returned no ephemeral credential")

    return {
        "client_secret": secret,
        "expires_at": payload.get("expires_at"),
        "model": model,
        "voice": voice,
        "webrtc_url": f"{root}/realtime/calls",
    }
