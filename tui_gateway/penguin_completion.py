"""Bounded Catalyst → Butler completion handoff for PENGUIN/EFFIGY speech.

The agent owns semantic output and its exact terminal role codeword. This adapter
never invents either. It submits only an exact completed EM/SIDEKICK response to
Butler's existing ``butler/response-completed`` owner and returns content-free
status suitable for a gateway event/log.
"""

from __future__ import annotations

import hashlib
import json
import os
import socket
from typing import Any, Callable

_METHOD = "butler/response-completed"
_CODEWORDS = {"EM": "🎼🐧", "SIDEKICK": "🧭🐧"}
_MAX_OUTPUT_BYTES = 1_000_000
_MAX_RESPONSE_BYTES = 262_144
_DEFAULT_ADDRESS = ("127.0.0.1", 4176)


def resolve_role(session: dict[str, Any], database: Any) -> str:
    """Resolve the host-owned role without exposing role choice to the model."""

    session_id = session.get("session_key")
    if not isinstance(session_id, str) or not session_id:
        return ""
    if database is not None:
        try:
            binding = database.get_external_role_session_binding(session_id)
        except (TypeError, ValueError):
            return ""
        if binding is not None:
            if (
                binding.get("namespace") != "agent-experiments"
                or binding.get("authority") != "observe"
                or binding.get("version") != 1
            ):
                return ""
            return {"em": "EM", "sidekick": "SIDEKICK"}.get(
                str(binding.get("role") or ""), ""
            )
    default = os.environ.get("HERMES_LUCID_ROLE", "").strip().upper()
    return default if default in _CODEWORDS else ""


def prepare_request(*, role: str, output: object, status: object) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """Build one closed request or a content-free skip/refusal observation."""

    if status != "complete":
        return None, _observation("skipped", "turn-not-complete")
    if role not in _CODEWORDS:
        return None, _observation("refused", "role-unavailable")
    if not isinstance(output, str) or not output.strip():
        return None, _observation("skipped", "completion-empty", role)
    try:
        encoded = output.encode("utf-8")
    except UnicodeEncodeError:
        return None, _observation("refused", "completion-invalid", role)
    if len(encoded) > _MAX_OUTPUT_BYTES:
        return None, _observation("refused", "completion-oversized", role)
    codeword = _CODEWORDS[role]
    if not output.rstrip().endswith(codeword):
        return None, _observation("refused", "codeword-missing", role)
    response_id = "turn:" + hashlib.sha256(encoded).hexdigest()
    params = {
        "schema": "response-final/1",
        "source": "direct",
        "response_id": response_id,
        "principal": role,
        "codeword_state": "exact",
        "expected_codeword": codeword,
        "output": output,
    }
    return params, _observation("pending", "completion-prepared", role, response_id)


def submit(
    params: dict[str, Any],
    *,
    exchange: Callable[[bytes], bytes] | None = None,
) -> dict[str, Any]:
    """Submit once to Butler with bounded loopback I/O and redact the result."""

    response_id = str(params.get("response_id") or "")
    role = str(params.get("principal") or "")
    request_id = response_id.removeprefix("turn:")
    frame = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": _METHOD,
        "params": params,
    }
    wire = (json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    try:
        raw = (exchange or _exchange)(wire)
        if len(raw) > _MAX_RESPONSE_BYTES:
            raise ValueError("response-over-bound")
        response = json.loads(raw.decode("utf-8"))
    except (OSError, TimeoutError):
        return _observation("unavailable", "butler-unavailable", role, response_id)
    except (UnicodeError, ValueError, json.JSONDecodeError):
        return _observation("failed", "butler-response-invalid", role, response_id)
    if not isinstance(response, dict) or response.get("id") != request_id:
        return _observation("failed", "butler-response-invalid", role, response_id)
    if isinstance(response.get("error"), dict):
        return _observation("refused", "butler-refused", role, response_id)
    result = response.get("result")
    if not isinstance(result, dict):
        return _observation("failed", "butler-response-invalid", role, response_id)
    speech = result.get("speech") if result.get("schema") == "response-completion-result/1" else None
    if not isinstance(speech, dict):
        return _observation("failed", "speech-receipt-missing", role, response_id)
    speech_status = str(speech.get("status") or "")
    code = str(speech.get("code") or "speech-receipt-invalid")
    state = "accepted" if speech.get("accepted") is True else (
        "unavailable" if speech_status == "unavailable" else "refused"
    )
    return _observation(state, code, role, response_id)


def _exchange(wire: bytes) -> bytes:
    with socket.create_connection(_DEFAULT_ADDRESS, timeout=0.25) as stream:
        stream.settimeout(1.25)
        stream.sendall(wire)
        stream.shutdown(socket.SHUT_WR)
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = stream.recv(min(65_536, _MAX_RESPONSE_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
            if total > _MAX_RESPONSE_BYTES:
                raise ValueError("response-over-bound")
        return b"".join(chunks).strip()


def _observation(
    status: str,
    code: str,
    role: str = "",
    response_id: str = "",
) -> dict[str, Any]:
    return {
        "schema": "penguin-completion-speech-status/1",
        "status": status,
        "code": code,
        "principal": role or None,
        "response_id": response_id or None,
        "content_free": True,
    }
