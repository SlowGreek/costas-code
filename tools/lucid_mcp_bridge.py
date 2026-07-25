"""Host-owned enrichment policy for the first-party LUCID MCP.

This module deliberately injects identity only. MCP request metadata is outside
model-controlled tool arguments and Butler defines the host-context extension as
``authority=none``. Capability issuance remains Butler/QUINE-owned; Hermes must
never synthesize, persist, log, or expose capability material.
"""

from __future__ import annotations

import os
import re
from typing import Any, Mapping, Optional

LUCID_SERVER_NAME = "lucid-quine"
HOST_CONTEXT_EXTENSION = "com.nous.lucid/host-context"
_MAX_SESSION_ID_BYTES = 192
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")


def _declared_lucid_transport(server_name: str, config: Mapping[str, Any]) -> bool:
    return (
        server_name == LUCID_SERVER_NAME
        and "url" not in config
        and os.path.basename(str(config.get("command", "")))
        in {"butler", "butler.exe"}
        and config.get("args") == ["--mcp-stdio"]
    )


def _canonical_lucid_transport(
    server_name: str,
    config: Mapping[str, Any],
    *,
    resolved_command: object = None,
) -> bool:
    """True only for the enrolled packaged Butler stdio invocation."""

    if not _declared_lucid_transport(server_name, config):
        return False
    admitted = os.environ.get("HERMES_LUCID_BUTLER_PATH", "")
    if not admitted or not isinstance(resolved_command, str) or not resolved_command:
        return False
    try:
        return os.path.realpath(resolved_command) == os.path.realpath(admitted)
    except OSError:
        return False


def _bounded_session_id(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    if not value or len(value.encode("utf-8")) > _MAX_SESSION_ID_BYTES:
        return None
    return value if _SESSION_ID_RE.fullmatch(value) else None


def lucid_host_context_meta(
    server_name: str,
    config: Mapping[str, Any],
    *,
    session_id: object = None,
    resolved_command: object = None,
) -> Optional[dict[str, dict[str, str]]]:
    """Return bounded MCP request metadata for an admitted LUCID call."""

    if not _canonical_lucid_transport(
        server_name, config, resolved_command=resolved_command
    ):
        return None
    admitted = _bounded_session_id(session_id)
    if admitted is None:
        return None
    return {HOST_CONTEXT_EXTENSION: {"session_id": admitted}}


def current_lucid_host_context_meta(
    server_name: str,
    config: Mapping[str, Any],
    *,
    session_id: object = None,
    resolved_command: object = None,
) -> Optional[dict[str, dict[str, str]]]:
    """Resolve host identity without reading model arguments.

    Modern dispatch passes an immutable ``session_id`` handler kwarg. Older
    entry points fall back to request-scoped ContextVars.
    """

    if _bounded_session_id(session_id) is not None:
        return lucid_host_context_meta(
            server_name,
            config,
            session_id=session_id,
            resolved_command=resolved_command,
        )

    from gateway.session_context import get_session_env

    fallback = get_session_env("HERMES_SESSION_CHAT_ID", "") or get_session_env(
        "HERMES_SESSION_ID", ""
    )
    return lucid_host_context_meta(
        server_name,
        config,
        session_id=fallback,
        resolved_command=resolved_command,
    )


def public_lucid_bridge_status(
    server_name: str, config: Mapping[str, Any]
) -> dict[str, object]:
    """Content-free declared posture safe for UI/logging."""

    declared = _declared_lucid_transport(server_name, config)
    runtime_path = os.environ.get("HERMES_LUCID_BUTLER_PATH", "")
    runtime_admitted = bool(
        declared
        and runtime_path
        and os.path.isfile(runtime_path)
        and os.access(runtime_path, os.X_OK)
    )
    return {
        "schema": "hermes-lucid-host-bridge/1",
        "server": LUCID_SERVER_NAME,
        "transport_admitted": runtime_admitted,
        "identity_binding": "request-scoped" if runtime_admitted else "unavailable",
        "authority": "butler-capability-required",
        "capability_material_exposed": False,
        "arguments_mutated": False,
        "receipt_owner": "Butler/Envelope",
    }
