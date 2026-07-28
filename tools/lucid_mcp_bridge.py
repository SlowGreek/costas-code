"""Host-owned enrichment policy for the first-party LUCID MCP.

This module deliberately injects identity only. MCP request metadata is outside
model-controlled tool arguments and Butler defines the host-context extension as
``authority=none``. Capability issuance remains Butler/QUINE-owned; Hermes must
never synthesize, persist, log, or expose capability material.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any, Mapping, Optional
from uuid import UUID

LUCID_SERVER_NAME = "lucid-quine"
HOST_CONTEXT_EXTENSION = "com.nous.lucid/host-context"
_MAX_SESSION_ID_BYTES = 192
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_RECEIPT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_CONTENT_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$")
_LUCID_VERBS = frozenset({"show", "get", "set", "morph", "dispatch", "steer", "cancel"})
_TRUST = frozenset({"untrusted", "attested", "signed", "verified"})
_REFUSAL_CODES = frozenset(
    {
        "no-capability",
        "scope-violation",
        "bad-signature",
        "unknown-verb",
        "malformed-args",
        "escalation-denied",
        "fidelity-floor",
        "internal-error",
    }
)
_NO_AUTOMATIC_RETRY = frozenset(
    {"lucid.show", "lucid.set", "lucid.morph", "lucid.dispatch", "lucid.steer", "lucid.cancel"}
)
_EXACT_CONFIRMATION_SCHEMA = "lucid-exact-confirmation/1"
_BOOTSTRAP_SCHEMA = "hermes-lucid-bootstrap-decision/1"
_HOST_ROLES = frozenset({"EM", "SIDEKICK"})


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
    if _SESSION_ID_RE.fullmatch(value) is None:
        return None
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError):
        return None
    canonical = str(parsed)
    return canonical if parsed.int != 0 and value.lower() == canonical else None


def lucid_host_context_meta(
    server_name: str,
    config: Mapping[str, Any],
    *,
    session_id: object = None,
    resolved_command: object = None,
    bootstrap: object = None,
    exact_confirmation: object = None,
) -> Optional[dict[str, dict[str, Any]]]:
    """Return bounded MCP request metadata for an admitted LUCID call."""

    if not _canonical_lucid_transport(
        server_name, config, resolved_command=resolved_command
    ):
        return None
    admitted = _bounded_session_id(session_id)
    if admitted is None:
        return None
    fields: dict[str, Any] = {"session_id": admitted, "authority": "none"}
    if bootstrap is not None:
        decision = _closed_object(
            bootstrap, {"schema", "action", "role", "role_session_id"}
        )
        if (
            decision is None
            or decision.get("schema") != _BOOTSTRAP_SCHEMA
            or decision.get("action") not in {"signin", "recover", "rotate"}
            or decision.get("role") not in _HOST_ROLES
            or _bounded_session_id(decision.get("role_session_id")) != admitted
        ):
            return None
        fields["bootstrap"] = dict(decision)
    if exact_confirmation is not None:
        confirmation = _closed_object(
            exact_confirmation, {"schema", "verb", "arguments_hash"}
        )
        if (
            confirmation is None
            or confirmation.get("schema") != _EXACT_CONFIRMATION_SCHEMA
            or confirmation.get("verb") != "cancel"
            or not isinstance(confirmation.get("arguments_hash"), str)
            or _CONTENT_HASH_RE.fullmatch(confirmation["arguments_hash"]) is None
        ):
            return None
        fields["exact_confirmation"] = dict(confirmation)
    return {HOST_CONTEXT_EXTENSION: fields}


def current_lucid_host_context_meta(
    server_name: str,
    config: Mapping[str, Any],
    *,
    conversation_id: object = None,
    session_id: object = None,
    resolved_command: object = None,
    bootstrap: object = None,
    exact_confirmation: object = None,
) -> Optional[dict[str, dict[str, Any]]]:
    """Resolve host identity without reading model arguments.

    Modern host dispatch may pass an immutable ``conversation_id`` handler
    kwarg. ``session_id`` remains a compatibility alias for host-owned callers.
    Older entry points fall back to the dedicated request-scoped ContextVar.
    Invalid explicit identity fails closed instead of borrowing an ambient
    sibling binding.
    """

    explicit = conversation_id if conversation_id is not None else session_id
    if explicit is not None:
        return lucid_host_context_meta(
            server_name,
            config,
            session_id=explicit,
            resolved_command=resolved_command,
            bootstrap=bootstrap,
            exact_confirmation=exact_confirmation,
        )

    from gateway.session_context import get_lucid_conversation_id

    return lucid_host_context_meta(
        server_name,
        config,
        session_id=get_lucid_conversation_id(),
        resolved_command=resolved_command,
        bootstrap=bootstrap,
        exact_confirmation=exact_confirmation,
    )


def lucid_signin_request() -> dict[str, str]:
    """Return Butler's closed host lifecycle request with no authority material."""

    return {"action": "signin", "path": "role-session"}


def lucid_host_role() -> Optional[str]:
    """Return the host-selected AE role; model arguments can never select it."""

    from gateway.session_context import get_lucid_role

    bound = get_lucid_role()
    if bound is not None:
        return bound if bound in _HOST_ROLES else None
    role = os.environ.get("HERMES_LUCID_ROLE", "").strip().upper()
    return role if role in _HOST_ROLES else None


def lucid_bootstrap_decision(
    conversation_id: object, *, action: str = "signin"
) -> Optional[dict[str, str]]:
    """Create the closed host decision for one exact role lifecycle call."""

    session_id = _bounded_session_id(conversation_id)
    role = lucid_host_role()
    if session_id is None or role is None or action not in {"signin", "recover", "rotate"}:
        return None
    return {
        "schema": _BOOTSTRAP_SCHEMA,
        "action": action,
        "role": role,
        "role_session_id": session_id,
    }


def lucid_unsigned_posture() -> dict[str, object]:
    """Typed fail-closed result for an admitted call lacking host identity."""

    return {
        "error": "LUCID conversation identity is unavailable",
        "code": "lucid-unsigned",
        "retryable": False,
        "authority": "none",
    }


def lucid_exact_confirmation(
    verb: str, arguments: object, *, confirmed: bool
) -> Optional[dict[str, str]]:
    """Bind an explicit host decision to the one currently confirmable call."""

    if verb != "cancel" or confirmed is not True or not isinstance(arguments, dict):
        return None
    try:
        canonical = json.dumps(
            arguments,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError):
        return None
    if len(canonical) > 131_072:
        return None
    return {
        "schema": _EXACT_CONFIRMATION_SCHEMA,
        "verb": verb,
        "arguments_hash": "sha256:" + hashlib.sha256(canonical).hexdigest(),
    }


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


def lucid_retry_disposition(
    server_name: str,
    config: Mapping[str, Any],
    tool_name: str,
    *,
    resolved_command: object = None,
) -> Optional[str]:
    """Classify transport retry policy for an exact admitted LUCID tool."""

    if not _canonical_lucid_transport(
        server_name, config, resolved_command=resolved_command
    ):
        return None
    if tool_name == "lucid.get":
        return "retry-safe-read"
    if tool_name in _NO_AUTOMATIC_RETRY:
        return "outcome-unknown"
    return None


def _closed_object(value: object, keys: set[str]) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict) or set(value) != keys:
        return None
    return value


def project_lucid_receipt(structured_content: object) -> Optional[dict[str, object]]:
    """Project one Envelope into a content-free, closed Hermes receipt DTO.

    Intent arguments, result payloads, capability material, effects, reasons,
    session identity, and unknown fields are structurally excluded.
    """

    if not isinstance(structured_content, dict):
        return None
    envelope = _closed_object(
        structured_content.get("envelope"),
        {"intent", "capability", "escalation", "fidelity", "refusal", "receipt"},
    )
    if envelope is None:
        return None
    intent = _closed_object(envelope.get("intent"), {"verb", "args"})
    receipt = _closed_object(
        envelope.get("receipt"),
        {"id", "ts", "trust", "content_hash", "ran", "effect"},
    )
    if intent is None or receipt is None or not isinstance(intent.get("args"), dict):
        return None

    verb = intent.get("verb")
    receipt_id = receipt.get("id")
    timestamp = receipt.get("ts")
    trust = receipt.get("trust")
    content_hash = receipt.get("content_hash")
    ran = receipt.get("ran")
    effect = receipt.get("effect")
    if (
        verb not in _LUCID_VERBS
        or not isinstance(receipt_id, str)
        or _RECEIPT_ID_RE.fullmatch(receipt_id) is None
        or not isinstance(timestamp, str)
        or _TIMESTAMP_RE.fullmatch(timestamp) is None
        or trust not in _TRUST
        or not isinstance(content_hash, str)
        or _CONTENT_HASH_RE.fullmatch(content_hash) is None
        or not isinstance(ran, bool)
        or not isinstance(effect, str)
        or len(effect.encode("utf-8")) > 4096
    ):
        return None

    refusal_code: Optional[str] = None
    refusal = envelope.get("refusal")
    if refusal is not None:
        refusal = _closed_object(refusal, {"code", "reason"})
        if refusal is None:
            return None
        refusal_code = refusal.get("code")
        reason = refusal.get("reason")
        if (
            refusal_code not in _REFUSAL_CODES
            or not isinstance(reason, str)
            or len(reason.encode("utf-8")) > 4096
        ):
            return None

    needs_user = False
    escalation = envelope.get("escalation")
    if escalation is not None:
        escalation = _closed_object(escalation, {"needs_user", "reason"})
        if escalation is None:
            return None
        needs_user = escalation.get("needs_user")
        reason = escalation.get("reason")
        if (
            not isinstance(needs_user, bool)
            or not isinstance(reason, str)
            or len(reason.encode("utf-8")) > 4096
        ):
            return None

    return {
        "schema": "hermes-lucid-receipt/1",
        "id": receipt_id,
        "timestamp": timestamp,
        "verb": verb,
        "ran": ran,
        "trust": trust,
        "content_hash": content_hash,
        "refusal_code": refusal_code,
        "needs_user": needs_user,
    }


def project_lucid_tool_result(
    structured_content: object,
    *,
    expected_verb: str,
    is_error: bool,
) -> dict[str, object]:
    """Project a received MCP result without any raw-text or Envelope fallback."""

    if expected_verb not in _LUCID_VERBS:
        return {
            "error": "LUCID request verb is not registered",
            "code": "lucid-invalid-request",
            "retryable": False,
        }
    receipt = project_lucid_receipt(structured_content)
    if receipt is None or receipt.get("verb") != expected_verb:
        return {
            "error": (
                "Butler returned an invalid LUCID refusal receipt"
                if is_error
                else "Butler returned an invalid LUCID success receipt"
            ),
            "code": "lucid-invalid-receipt",
            "retryable": False,
        }
    if not isinstance(structured_content, dict):
        return {
            "error": "Butler returned an invalid LUCID success receipt",
            "code": "lucid-invalid-receipt",
            "retryable": False,
        }
    if is_error or receipt.get("refusal_code") is not None:
        refusal = receipt.get("refusal_code")
        return {
            "error": (
                f"Butler refused LUCID call ({refusal})"
                if refusal
                else "Butler returned a LUCID error receipt"
            ),
            "lucid_receipt": receipt,
        }
    if "result" not in structured_content:
        return {
            "error": "Butler returned an invalid LUCID success receipt",
            "code": "lucid-invalid-receipt",
            "retryable": False,
        }
    return {"result": structured_content["result"], "lucid_receipt": receipt}


def lucid_outcome_unknown(verb: str) -> dict[str, object]:
    """Closed no-retry posture for an ambiguous consequential call."""

    if f"lucid.{verb}" not in _NO_AUTOMATIC_RETRY:
        return {
            "error": "LUCID request verb is not registered for consequential execution",
            "code": "lucid-invalid-request",
            "retryable": False,
        }
    return {
        "error": "LUCID call outcome is unknown; automatic retry is disabled",
        "code": "lucid-outcome-unknown",
        "retryable": False,
        "server": LUCID_SERVER_NAME,
        "tool": f"lucid.{verb}",
    }
