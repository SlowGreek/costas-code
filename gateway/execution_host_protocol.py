"""Effect-free execution-host protocol R0 parsing and verification.

This module deliberately stops before transport, persistence, runtime lookup, or
execution.  It accepts only canonical, closed JSON values; compares enrollment
claims with separately supplied observations; verifies Ed25519 possession; and
asks an injected state owner to atomically consume replay/order coordinates.
"""

from __future__ import annotations

import base64
import hashlib
import json
import unicodedata
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

SCHEMA = "costas-execution-host-r0/1"
RECEIPT_SCHEMA = "costas-execution-host-verification-receipt-r0/1"
MAX_WIRE_BYTES = 32_768
MAX_TTL_SECONDS = 900
MAX_EVENT_PAGE = 32
MAX_U64 = (1 << 64) - 1
MAX_I64 = (1 << 63) - 1

OPERATIONS = frozenset(
    {"spawn_read_only", "events", "health", "steer", "interrupt", "close"}
)
CAPABILITIES = tuple(sorted(OPERATIONS))

_HASH_FIELDS = {
    "butler_process_episode_hash",
    "costas_process_episode_hash",
    "host_instance_hash",
    "executable_hash",
    "bundle_hash",
    "project_hash",
    "profile_hash",
    "enrollment_hash",
    "command_scope_hash",
    "parent_context_hash",
    "dispatch_hash",
    "runtime_binding_hash",
    "active_turn_hash",
    "control_payload_hash",
}
_FORBIDDEN_KEYS = frozenset(
    {
        "aiagent",
        "ai_agent",
        "agent_object",
        "observations",
        "observed",
        "provider",
        "provider_id",
        "raw_provider_id",
        "session",
        "session_id",
        "raw_session_id",
        "thread",
        "thread_id",
        "raw_thread_id",
        "turn",
        "turn_id",
        "raw_turn_id",
        "rpc",
        "rpc_method",
        "method",
        "challenge_hash",
        "host_proof_hash",
    }
)
_ENROLLMENT_KEYS = frozenset(
    {
        "schema",
        "type",
        "challenge_nonce",
        "butler_key_id",
        "costas_key_id",
        "butler_process_episode_hash",
        "costas_process_episode_hash",
        "host_instance_hash",
        "executable_hash",
        "bundle_hash",
        "project_hash",
        "profile_hash",
        "capabilities",
        "issued_at",
        "expires_at",
        "revocation_generation",
        "butler_signature",
        "costas_proof",
    }
)
_COMMAND_KEYS = frozenset(
    {
        "schema",
        "type",
        "enrollment_hash",
        "operation",
        "command_scope_hash",
        "sequence",
        "nonce",
        "issued_at",
        "expires_at",
        "revocation_generation",
        "payload",
        "butler_key_id",
        "butler_signature",
    }
)
_PAYLOAD_KEYS = {
    "spawn_read_only": frozenset(
        {"parent_context_hash", "dispatch_hash", "project_hash", "profile_hash"}
    ),
    "events": frozenset({"runtime_binding_hash", "after_cursor", "limit"}),
    "health": frozenset({"runtime_binding_hash"}),
    "steer": frozenset(
        {"runtime_binding_hash", "active_turn_hash", "control_payload_hash"}
    ),
    "interrupt": frozenset(
        {"runtime_binding_hash", "active_turn_hash", "control_payload_hash"}
    ),
    "close": frozenset({"runtime_binding_hash"}),
}


class ProtocolError(ValueError):
    """A stable, content-free protocol refusal."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class StateDecision(str, Enum):
    """Atomic decision returned by the injected replay/revocation owner."""

    COMMITTED = "committed"
    DUPLICATE = "duplicate"
    OUTCOME_UNKNOWN = "outcome-unknown"
    NONCE_REPLAY = "nonce-replay"
    SEQUENCE_CONFLICT = "sequence-conflict"
    REVOKED = "revoked"
    CAPACITY = "capacity"


class ReceiptSigner(Protocol):
    """Injected ephemeral signing capability; key storage remains another owner."""

    @property
    def key_id(self) -> str: ...

    def sign(self, material: bytes) -> bytes: ...


class CompareAndSwapState(Protocol):
    """State owner; each method must check generation and commit atomically."""

    def consume_enrollment_nonce(
        self,
        *,
        nonce_hash: str,
        enrollment_hash: str,
        expires_at: int,
        revocation_generation: int,
    ) -> StateDecision: ...

    def commit_command(
        self,
        *,
        enrollment_hash: str,
        command_scope_hash: str,
        expected_previous_sequence: int,
        sequence: int,
        nonce_hash: str,
        request_hash: str,
        expires_at: int,
        revocation_generation: int,
    ) -> StateDecision: ...


@dataclass(frozen=True)
class HostObservations:
    """Facts measured outside the untrusted wire document."""

    butler_process_episode_hash: str
    costas_process_episode_hash: str
    host_instance_hash: str
    executable_hash: str
    bundle_hash: str
    project_hash: str
    profile_hash: str
    capabilities: tuple[str, ...]

    def __post_init__(self) -> None:
        for name in (
            "butler_process_episode_hash",
            "costas_process_episode_hash",
            "host_instance_hash",
            "executable_hash",
            "bundle_hash",
            "project_hash",
            "profile_hash",
        ):
            _require_hash(getattr(self, name), name)
        _require_capabilities(list(self.capabilities))


@dataclass(frozen=True)
class EnrollmentClaim:
    document: dict[str, Any]
    unsigned_document: dict[str, Any]
    canonical_bytes: bytes
    enrollment_hash: str


@dataclass(frozen=True)
class CommandClaim:
    document: dict[str, Any]
    unsigned_document: dict[str, Any]
    canonical_bytes: bytes
    request_hash: str


@dataclass(frozen=True)
class VerifiedEnrollment:
    enrollment_hash: str
    observations: HostObservations
    capabilities: tuple[str, ...]
    expires_at: int
    revocation_generation: int


@dataclass(frozen=True)
class VerificationReceipt:
    """Signed, typed, content-free result; it never represents execution."""

    document: dict[str, Any]

    @property
    def status(self) -> str:
        return self.document["status"]

    @property
    def code(self) -> str:
        return self.document["code"]

    def to_bytes(self) -> bytes:
        return canonical_json_bytes(self.document)


@dataclass(frozen=True)
class EnrollmentVerification:
    enrollment: VerifiedEnrollment | None
    receipt: VerificationReceipt


@dataclass(frozen=True)
class CommandVerification:
    command: CommandClaim | None
    receipt: VerificationReceipt


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError("duplicate-json-key")
        result[key] = value
    return result


def _reject_float(_value: str) -> None:
    raise ProtocolError("json-float-forbidden")


def _reject_constant(_value: str) -> None:
    raise ProtocolError("json-constant-forbidden")


def canonical_json_bytes(value: Any) -> bytes:
    """NFC UTF-8, sorted keys, compact separators, and exactly one final LF."""

    text = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return (unicodedata.normalize("NFC", text) + "\n").encode("utf-8")


def parse_canonical_json(wire: bytes) -> dict[str, Any]:
    if not isinstance(wire, bytes) or not wire or len(wire) > MAX_WIRE_BYTES:
        raise ProtocolError("wire-size-invalid")
    try:
        text = wire.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ProtocolError("wire-utf8-invalid") from exc
    if unicodedata.normalize("NFC", text) != text:
        raise ProtocolError("wire-unicode-not-nfc")
    try:
        value = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_float=_reject_float,
            parse_constant=_reject_constant,
        )
    except ProtocolError:
        raise
    except (json.JSONDecodeError, RecursionError) as exc:
        raise ProtocolError("wire-json-invalid") from exc
    if not isinstance(value, dict):
        raise ProtocolError("wire-root-not-object")
    try:
        canonical = canonical_json_bytes(value)
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise ProtocolError("wire-json-invalid") from exc
    if wire != canonical:
        raise ProtocolError("wire-not-canonical")
    _reject_forbidden_fields(value)
    return value


def _reject_forbidden_fields(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = key.lower()
            if lowered in _FORBIDDEN_KEYS or lowered.startswith("observed_"):
                raise ProtocolError("forbidden-field")
            _reject_forbidden_fields(child)
    elif isinstance(value, list):
        for child in value:
            _reject_forbidden_fields(child)


def _require_exact_keys(value: dict[str, Any], expected: frozenset[str], code: str) -> None:
    if frozenset(value) != expected:
        raise ProtocolError(code)


def _require_string(value: Any, name: str, *, minimum: int = 1, maximum: int = 128) -> str:
    if not isinstance(value, str) or not minimum <= len(value) <= maximum:
        raise ProtocolError(f"{name}-invalid")
    if not value.isascii():
        raise ProtocolError(f"{name}-invalid")
    return value


def _require_hash(value: Any, name: str) -> str:
    if not isinstance(value, str) or len(value) != 71 or not value.startswith("sha256:"):
        raise ProtocolError(f"{name}-invalid")
    hex_part = value[7:]
    if any(char not in "0123456789abcdef" for char in hex_part):
        raise ProtocolError(f"{name}-invalid")
    return value


def _require_u64(value: Any, name: str, *, positive: bool = False) -> int:
    lower = 1 if positive else 0
    if isinstance(value, bool) or not isinstance(value, int) or not lower <= value <= MAX_U64:
        raise ProtocolError(f"{name}-invalid")
    return value


def _require_time(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_I64:
        raise ProtocolError(f"{name}-invalid")
    return value


def _require_nonce(value: Any, name: str) -> str:
    text = _require_string(value, name, minimum=16, maximum=128)
    if any(not (char.isalnum() or char in "-_") for char in text):
        raise ProtocolError(f"{name}-invalid")
    return text


def _require_signature(value: Any, name: str) -> bytes:
    encoded = _require_string(value, name, minimum=86, maximum=86)
    try:
        decoded = base64.urlsafe_b64decode(encoded + "==")
    except (ValueError, TypeError) as exc:
        raise ProtocolError(f"{name}-invalid") from exc
    if len(decoded) != 64 or _b64url(decoded) != encoded:
        raise ProtocolError(f"{name}-invalid")
    return decoded


def _require_capabilities(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= len(CAPABILITIES):
        raise ProtocolError("capabilities-invalid")
    if any(not isinstance(item, str) for item in value):
        raise ProtocolError("capabilities-invalid")
    if value != sorted(value) or len(set(value)) != len(value):
        raise ProtocolError("capabilities-not-canonical")
    if any(item not in OPERATIONS for item in value):
        raise ProtocolError("capability-unsupported")
    return tuple(value)


def _require_times(document: dict[str, Any]) -> tuple[int, int]:
    issued = _require_time(document["issued_at"], "issued-at")
    expires = _require_time(document["expires_at"], "expires-at")
    if expires <= issued or expires - issued > MAX_TTL_SECONDS:
        raise ProtocolError("ttl-invalid")
    return issued, expires


def _unsigned(document: dict[str, Any], *signature_fields: str) -> dict[str, Any]:
    return {key: value for key, value in document.items() if key not in signature_fields}


def _sha256(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _public_key_id(key: Ed25519PublicKey) -> str:
    raw = key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return _sha256(raw)


def _signature_material(domain: bytes, document: dict[str, Any]) -> bytes:
    return domain + b"\x00" + canonical_json_bytes(document)


def parse_enrollment(wire: bytes) -> EnrollmentClaim:
    document = parse_canonical_json(wire)
    _require_exact_keys(document, _ENROLLMENT_KEYS, "enrollment-shape-invalid")
    if document["schema"] != SCHEMA or document["type"] != "enrollment":
        raise ProtocolError("enrollment-schema-invalid")
    _require_nonce(document["challenge_nonce"], "challenge-nonce")
    for key in _HASH_FIELDS & _ENROLLMENT_KEYS:
        _require_hash(document[key], key.replace("_", "-"))
    _require_hash(document["butler_key_id"], "butler-key-id")
    _require_hash(document["costas_key_id"], "costas-key-id")
    _require_capabilities(document["capabilities"])
    _require_times(document)
    _require_u64(document["revocation_generation"], "revocation-generation")
    _require_signature(document["butler_signature"], "butler-signature")
    _require_signature(document["costas_proof"], "costas-proof")
    unsigned = _unsigned(document, "butler_signature", "costas_proof")
    return EnrollmentClaim(document, unsigned, wire, _sha256(wire))


def parse_command(wire: bytes) -> CommandClaim:
    document = parse_canonical_json(wire)
    _require_exact_keys(document, _COMMAND_KEYS, "command-shape-invalid")
    if document["schema"] != SCHEMA or document["type"] != "command":
        raise ProtocolError("command-schema-invalid")
    operation = document["operation"]
    if not isinstance(operation, str) or operation not in OPERATIONS:
        raise ProtocolError("operation-unsupported")
    for key in ("enrollment_hash", "command_scope_hash"):
        _require_hash(document[key], key.replace("_", "-"))
    _require_u64(document["sequence"], "sequence", positive=True)
    _require_nonce(document["nonce"], "nonce")
    _require_times(document)
    _require_u64(document["revocation_generation"], "revocation-generation")
    _require_hash(document["butler_key_id"], "butler-key-id")
    _require_signature(document["butler_signature"], "butler-signature")
    payload = document["payload"]
    if not isinstance(payload, dict):
        raise ProtocolError("payload-invalid")
    _require_exact_keys(payload, _PAYLOAD_KEYS[operation], "payload-shape-invalid")
    for key, value in payload.items():
        if key in _HASH_FIELDS:
            _require_hash(value, key.replace("_", "-"))
    if operation == "events":
        _require_u64(payload["after_cursor"], "after-cursor")
        limit = _require_u64(payload["limit"], "limit", positive=True)
        if limit > MAX_EVENT_PAGE:
            raise ProtocolError("event-page-bounds")
    if operation == "spawn_read_only":
        if document["command_scope_hash"] != payload["dispatch_hash"]:
            raise ProtocolError("command-scope-mismatch")
    elif document["command_scope_hash"] != payload["runtime_binding_hash"]:
        raise ProtocolError("command-scope-mismatch")
    unsigned = _unsigned(document, "butler_signature")
    return CommandClaim(document, unsigned, wire, _sha256(wire))


def _compare_observations(document: dict[str, Any], observed: HostObservations) -> None:
    for name in (
        "butler_process_episode_hash",
        "costas_process_episode_hash",
        "host_instance_hash",
        "executable_hash",
        "bundle_hash",
        "project_hash",
        "profile_hash",
    ):
        if document[name] != getattr(observed, name):
            raise ProtocolError(f"foreign-{name.removesuffix('_hash').replace('_', '-')}")
    if tuple(document["capabilities"]) != observed.capabilities:
        raise ProtocolError("foreign-capabilities")


class ExecutionHostVerifier:
    """Pure verifier around pinned keys, an injected clock value, and CAS state."""

    def __init__(
        self,
        *,
        butler_public_key: Ed25519PublicKey,
        costas_public_key: Ed25519PublicKey,
        receipt_signer: ReceiptSigner,
        state: CompareAndSwapState,
    ) -> None:
        self._butler_public_key = butler_public_key
        self._costas_public_key = costas_public_key
        self._receipt_signer = receipt_signer
        self._state = state
        self.butler_key_id = _public_key_id(butler_public_key)
        self.costas_key_id = _public_key_id(costas_public_key)
        self.receipt_key_id = receipt_signer.key_id

    def verify_enrollment(
        self, wire: bytes, *, observed: HostObservations, now: int
    ) -> EnrollmentVerification:
        request_hash = _sha256(wire) if isinstance(wire, bytes) else _sha256(b"")
        try:
            claim = parse_enrollment(wire)
            document = claim.document
            if document["butler_key_id"] != self.butler_key_id:
                raise ProtocolError("butler-key-not-pinned")
            if document["costas_key_id"] != self.costas_key_id:
                raise ProtocolError("costas-key-not-pinned")
            issued, expires = _require_times(document)
            if issued > now or expires <= now:
                raise ProtocolError("enrollment-time-invalid")
            _compare_observations(document, observed)
            material = _signature_material(b"costas-execution-host-enrollment-r0", claim.unsigned_document)
            self._verify_signature(
                self._butler_public_key,
                document["butler_signature"],
                material,
                "butler-signature-invalid",
            )
            self._verify_signature(
                self._costas_public_key,
                document["costas_proof"],
                material,
                "costas-proof-invalid",
            )
            decision = self._state.consume_enrollment_nonce(
                nonce_hash=_sha256(document["challenge_nonce"].encode("ascii")),
                enrollment_hash=claim.enrollment_hash,
                expires_at=expires,
                revocation_generation=document["revocation_generation"],
            )
            if decision is not StateDecision.COMMITTED:
                status, code = _state_receipt(decision)
                return EnrollmentVerification(
                    None,
                    self._receipt(
                        receipt_type="enrollment",
                        status=status,
                        code=code,
                        request_hash=request_hash,
                        enrollment_hash=claim.enrollment_hash,
                        command_scope_hash=None,
                        sequence=None,
                        revocation_generation=document["revocation_generation"],
                        now=now,
                    ),
                )
            verified = VerifiedEnrollment(
                enrollment_hash=claim.enrollment_hash,
                observations=observed,
                capabilities=tuple(document["capabilities"]),
                expires_at=expires,
                revocation_generation=document["revocation_generation"],
            )
            return EnrollmentVerification(
                verified,
                self._receipt(
                    receipt_type="enrollment",
                    status="verified-not-run",
                    code="verified",
                    request_hash=request_hash,
                    enrollment_hash=claim.enrollment_hash,
                    command_scope_hash=None,
                    sequence=None,
                    revocation_generation=document["revocation_generation"],
                    now=now,
                ),
            )
        except ProtocolError as exc:
            return EnrollmentVerification(
                None,
                self._receipt(
                    receipt_type="enrollment",
                    status="refused",
                    code=exc.code,
                    request_hash=request_hash,
                    enrollment_hash=None,
                    command_scope_hash=None,
                    sequence=None,
                    revocation_generation=None,
                    now=now,
                ),
            )

    def verify_command(
        self,
        wire: bytes,
        *,
        enrollment: VerifiedEnrollment,
        observed: HostObservations,
        now: int,
    ) -> CommandVerification:
        request_hash = _sha256(wire) if isinstance(wire, bytes) else _sha256(b"")
        parsed: CommandClaim | None = None
        try:
            parsed = parse_command(wire)
            document = parsed.document
            if document["butler_key_id"] != self.butler_key_id:
                raise ProtocolError("butler-key-not-pinned")
            if document["enrollment_hash"] != enrollment.enrollment_hash:
                raise ProtocolError("foreign-enrollment")
            if enrollment.observations != observed:
                raise ProtocolError("observation-changed")
            if enrollment.expires_at <= now:
                raise ProtocolError("enrollment-expired")
            if document["revocation_generation"] != enrollment.revocation_generation:
                raise ProtocolError("revocation-generation-mismatch")
            operation = document["operation"]
            if operation not in enrollment.capabilities:
                raise ProtocolError("capability-unavailable")
            issued, expires = _require_times(document)
            if issued > now or expires <= now or expires > enrollment.expires_at:
                raise ProtocolError("command-time-invalid")
            if operation == "spawn_read_only":
                payload = document["payload"]
                if payload["project_hash"] != observed.project_hash:
                    raise ProtocolError("foreign-project")
                if payload["profile_hash"] != observed.profile_hash:
                    raise ProtocolError("foreign-profile")
            material = _signature_material(b"costas-execution-host-command-r0", parsed.unsigned_document)
            self._verify_signature(
                self._butler_public_key,
                document["butler_signature"],
                material,
                "butler-signature-invalid",
            )
            sequence = document["sequence"]
            try:
                decision = self._state.commit_command(
                    enrollment_hash=enrollment.enrollment_hash,
                    command_scope_hash=document["command_scope_hash"],
                    expected_previous_sequence=sequence - 1,
                    sequence=sequence,
                    nonce_hash=_sha256(document["nonce"].encode("ascii")),
                    request_hash=parsed.request_hash,
                    expires_at=expires,
                    revocation_generation=document["revocation_generation"],
                )
            except Exception:
                decision = StateDecision.OUTCOME_UNKNOWN
            status, code = _state_receipt(decision)
            if decision is StateDecision.COMMITTED:
                status, code = "verified-not-run", "verified"
            return CommandVerification(
                parsed if decision is StateDecision.COMMITTED else None,
                self._receipt(
                    receipt_type="command",
                    status=status,
                    code=code,
                    request_hash=request_hash,
                    enrollment_hash=enrollment.enrollment_hash,
                    command_scope_hash=document["command_scope_hash"],
                    sequence=sequence,
                    revocation_generation=document["revocation_generation"],
                    now=now,
                ),
            )
        except ProtocolError as exc:
            return CommandVerification(
                None,
                self._receipt(
                    receipt_type="command",
                    status="refused",
                    code=exc.code,
                    request_hash=request_hash,
                    enrollment_hash=enrollment.enrollment_hash,
                    command_scope_hash=None,
                    sequence=None,
                    revocation_generation=enrollment.revocation_generation,
                    now=now,
                ),
            )

    @staticmethod
    def _verify_signature(
        key: Ed25519PublicKey, encoded_signature: str, material: bytes, code: str
    ) -> None:
        # _require_signature accepts a field label and appends "-invalid".
        # Keep malformed encoding and cryptographic mismatch on the same stable
        # refusal code instead of producing e.g. "butler-signature-invalid-invalid".
        label = code.removesuffix("-invalid")
        signature = _require_signature(encoded_signature, label)
        try:
            key.verify(signature, material)
        except InvalidSignature as exc:
            raise ProtocolError(code) from exc

    def _receipt(
        self,
        *,
        receipt_type: str,
        status: str,
        code: str,
        request_hash: str,
        enrollment_hash: str | None,
        command_scope_hash: str | None,
        sequence: int | None,
        revocation_generation: int | None,
        now: int,
    ) -> VerificationReceipt:
        body = {
            "schema": RECEIPT_SCHEMA,
            "type": "verification_receipt",
            "receipt_type": receipt_type,
            "status": status,
            "code": code,
            "request_hash": request_hash,
            "enrollment_hash": enrollment_hash,
            "command_scope_hash": command_scope_hash,
            "sequence": sequence,
            "revocation_generation": revocation_generation,
            "issued_at": now,
            "receipt_key_id": self.receipt_key_id,
        }
        material = _signature_material(b"costas-execution-host-receipt-r0", body)
        signed = {**body, "signature": _b64url(self._receipt_signer.sign(material))}
        return VerificationReceipt(signed)


def verify_receipt_signature(receipt: VerificationReceipt, key: Ed25519PublicKey) -> bool:
    document = receipt.document
    signature = document.get("signature")
    if not isinstance(signature, str):
        return False
    unsigned = _unsigned(document, "signature")
    if unsigned.get("receipt_key_id") != _public_key_id(key):
        return False
    try:
        decoded = _require_signature(signature, "receipt-signature")
        key.verify(
            decoded,
            _signature_material(b"costas-execution-host-receipt-r0", unsigned),
        )
    except (ProtocolError, InvalidSignature):
        return False
    return True


def _state_receipt(decision: StateDecision) -> tuple[str, str]:
    mapping = {
        StateDecision.COMMITTED: ("verified-not-run", "verified"),
        StateDecision.DUPLICATE: ("duplicate", "duplicate-request"),
        StateDecision.OUTCOME_UNKNOWN: ("outcome-unknown", "prior-outcome-unavailable"),
        StateDecision.NONCE_REPLAY: ("refused", "nonce-replay"),
        StateDecision.SEQUENCE_CONFLICT: ("refused", "sequence-conflict"),
        StateDecision.REVOKED: ("refused", "revoked"),
        StateDecision.CAPACITY: ("refused", "state-capacity"),
    }
    if decision not in mapping:
        raise ProtocolError("state-decision-invalid")
    return mapping[decision]


def key_id(key: Ed25519PublicKey) -> str:
    """Return the canonical pinned-key identifier."""

    return _public_key_id(key)
