from __future__ import annotations

import base64
import copy
import hashlib
import json
from dataclasses import replace

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from gateway.execution_host_protocol import (
    CAPABILITIES,
    MAX_EVENT_PAGE,
    CommandClaim,
    ExecutionHostVerifier,
    HostObservations,
    ProtocolError,
    StateDecision,
    canonical_json_bytes,
    key_id,
    parse_canonical_json,
    parse_command,
    parse_enrollment,
    verify_receipt_signature,
)

NOW = 1_800_000_000
GENERATION = 7


def _private(seed: int) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(bytes([seed]) * 32)


def _hash(label: str) -> str:
    return "sha256:" + hashlib.sha256(label.encode("ascii")).hexdigest()


def _sign_enrollment_document(
    document: dict,
    *,
    butler_private_key: Ed25519PrivateKey,
    costas_private_key: Ed25519PrivateKey,
) -> bytes:
    unsigned = {
        key: value
        for key, value in document.items()
        if key not in {"butler_signature", "costas_proof"}
    }
    material = (
        b"costas-execution-host-enrollment-r0\x00" + canonical_json_bytes(unsigned)
    )
    encode = lambda value: base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")
    return canonical_json_bytes(
        {
            **unsigned,
            "butler_signature": encode(butler_private_key.sign(material)),
            "costas_proof": encode(costas_private_key.sign(material)),
        }
    )


def _sign_command_document(
    document: dict, *, butler_private_key: Ed25519PrivateKey
) -> bytes:
    unsigned = {
        key: value for key, value in document.items() if key != "butler_signature"
    }
    material = b"costas-execution-host-command-r0\x00" + canonical_json_bytes(unsigned)
    signature = base64.urlsafe_b64encode(butler_private_key.sign(material)).decode(
        "ascii"
    ).rstrip("=")
    return canonical_json_bytes({**unsigned, "butler_signature": signature})


class FakeReceiptSigner:
    def __init__(self, private_key: Ed25519PrivateKey):
        self._private_key = private_key
        self.key_id = key_id(private_key.public_key())

    def sign(self, material: bytes) -> bytes:
        return self._private_key.sign(material)


class FakeCasState:
    def __init__(self, generation: int = GENERATION):
        self.generation = generation
        self.enrollment_nonces: dict[str, str] = {}
        self.commands: dict[tuple[str, str], tuple[int, str, str]] = {}
        self.command_nonces: dict[str, str] = {}
        self.next_enrollment_decision: StateDecision | None = None
        self.next_command_decision: StateDecision | None = None
        self.raise_command_error = False
        self.enrollment_calls = 0
        self.command_calls = 0

    def consume_enrollment_nonce(
        self,
        *,
        nonce_hash: str,
        enrollment_hash: str,
        expires_at: int,
        revocation_generation: int,
    ) -> StateDecision:
        del expires_at
        self.enrollment_calls += 1
        if self.next_enrollment_decision is not None:
            decision, self.next_enrollment_decision = self.next_enrollment_decision, None
            return decision
        if revocation_generation != self.generation:
            return StateDecision.REVOKED
        if nonce_hash in self.enrollment_nonces:
            return StateDecision.NONCE_REPLAY
        self.enrollment_nonces[nonce_hash] = enrollment_hash
        return StateDecision.COMMITTED

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
    ) -> StateDecision:
        del expires_at
        self.command_calls += 1
        if self.raise_command_error:
            raise OSError("simulated-cas-write-ambiguity")
        if self.next_command_decision is not None:
            decision, self.next_command_decision = self.next_command_decision, None
            return decision
        if revocation_generation != self.generation:
            return StateDecision.REVOKED
        key = (enrollment_hash, command_scope_hash)
        prior = self.commands.get(key)
        if prior is not None and prior[0] == sequence and prior[1] == request_hash:
            return StateDecision.DUPLICATE
        if nonce_hash in self.command_nonces:
            return StateDecision.NONCE_REPLAY
        previous_sequence = 0 if prior is None else prior[0]
        if previous_sequence != expected_previous_sequence or sequence != previous_sequence + 1:
            return StateDecision.SEQUENCE_CONFLICT
        self.commands[key] = (sequence, request_hash, nonce_hash)
        self.command_nonces[nonce_hash] = request_hash
        return StateDecision.COMMITTED


@pytest.fixture
def keys():
    return _private(1), _private(2), _private(3)


@pytest.fixture
def observations() -> HostObservations:
    return HostObservations(
        butler_process_episode_hash=_hash("butler-process-episode"),
        costas_process_episode_hash=_hash("costas-process-episode"),
        host_instance_hash=_hash("costas-host-instance"),
        executable_hash=_hash("hermes-executable-bytes"),
        bundle_hash=_hash("hermes-code-bundle"),
        project_hash=_hash("agent-experiments-project"),
        profile_hash=_hash("fleet-read-only-profile"),
        capabilities=CAPABILITIES,
    )


@pytest.fixture
def state() -> FakeCasState:
    return FakeCasState()


@pytest.fixture
def verifier(keys, state) -> ExecutionHostVerifier:
    butler, costas, receipt = keys
    return ExecutionHostVerifier(
        butler_public_key=butler.public_key(),
        costas_public_key=costas.public_key(),
        receipt_signer=FakeReceiptSigner(receipt),
        state=state,
    )


def _enrollment_document(verifier: ExecutionHostVerifier, observed: HostObservations) -> dict:
    return {
        "schema": "costas-execution-host-r0/1",
        "type": "enrollment",
        "challenge_nonce": "challenge-nonce-00000001",
        "butler_key_id": verifier.butler_key_id,
        "costas_key_id": verifier.costas_key_id,
        "butler_process_episode_hash": observed.butler_process_episode_hash,
        "costas_process_episode_hash": observed.costas_process_episode_hash,
        "host_instance_hash": observed.host_instance_hash,
        "executable_hash": observed.executable_hash,
        "bundle_hash": observed.bundle_hash,
        "project_hash": observed.project_hash,
        "profile_hash": observed.profile_hash,
        "capabilities": list(observed.capabilities),
        "issued_at": NOW,
        "expires_at": NOW + 300,
        "revocation_generation": GENERATION,
    }


def _enrollment_wire(verifier, observations, keys, **updates) -> bytes:
    document = _enrollment_document(verifier, observations)
    document.update(updates)
    butler, costas, _ = keys
    return _sign_enrollment_document(
        document,
        butler_private_key=butler,
        costas_private_key=costas,
    )


def _verified_enrollment(verifier, observations, keys):
    result = verifier.verify_enrollment(
        _enrollment_wire(verifier, observations, keys), observed=observations, now=NOW + 1
    )
    assert result.enrollment is not None
    assert result.receipt.status == "verified-not-run"
    return result.enrollment


def _payload(operation: str, observations: HostObservations, scope: str) -> dict:
    binding = _hash(scope)
    if operation == "spawn_read_only":
        return {
            "parent_context_hash": _hash("parent-context"),
            "dispatch_hash": binding,
            "project_hash": observations.project_hash,
            "profile_hash": observations.profile_hash,
        }
    if operation == "events":
        return {"runtime_binding_hash": binding, "after_cursor": 0, "limit": 16}
    if operation in {"steer", "interrupt"}:
        return {
            "runtime_binding_hash": binding,
            "active_turn_hash": _hash("active-turn"),
            "control_payload_hash": _hash(f"{operation}-content-owned-elsewhere"),
        }
    return {"runtime_binding_hash": binding}


def _command_document(
    verifier: ExecutionHostVerifier,
    enrollment_hash: str,
    observations: HostObservations,
    operation: str = "health",
    *,
    sequence: int = 1,
    nonce: str = "command-nonce-0000000001",
    scope: str = "runtime-binding-one",
) -> dict:
    payload = _payload(operation, observations, scope)
    command_scope_hash = (
        payload["dispatch_hash"] if operation == "spawn_read_only" else payload["runtime_binding_hash"]
    )
    return {
        "schema": "costas-execution-host-r0/1",
        "type": "command",
        "enrollment_hash": enrollment_hash,
        "operation": operation,
        "command_scope_hash": command_scope_hash,
        "sequence": sequence,
        "nonce": nonce,
        "issued_at": NOW + 1,
        "expires_at": NOW + 61,
        "revocation_generation": GENERATION,
        "payload": payload,
        "butler_key_id": verifier.butler_key_id,
    }


def _command_wire(verifier, enrollment, observations, keys, operation="health", **kwargs):
    document = _command_document(
        verifier, enrollment.enrollment_hash, observations, operation, **kwargs
    )
    return _sign_command_document(document, butler_private_key=keys[0])


def _assert_signed_content_free_receipt(result, keys) -> None:
    receipt = result.receipt
    assert verify_receipt_signature(receipt, keys[2].public_key())
    assert set(receipt.document) == {
        "schema",
        "type",
        "receipt_type",
        "status",
        "code",
        "request_hash",
        "enrollment_hash",
        "command_scope_hash",
        "sequence",
        "revocation_generation",
        "issued_at",
        "receipt_key_id",
        "signature",
    }
    wire = receipt.to_bytes()
    assert parse_canonical_json(wire) == receipt.document
    forbidden = (
        b"payload",
        b"provider_id",
        b"session_id",
        b"thread_id",
        b"turn_id",
        b"rpc_method",
        b"challenge_nonce",
    )
    assert not any(value in wire for value in forbidden)


def test_canonical_parser_rejects_duplicate_keys_noncanonical_bytes_floats_and_constants():
    with pytest.raises(ProtocolError, match="duplicate-json-key"):
        parse_canonical_json(b'{"a":1,"a":2}\n')
    with pytest.raises(ProtocolError, match="wire-not-canonical"):
        parse_canonical_json(b'{ "a": 1 }\n')
    with pytest.raises(ProtocolError, match="json-float-forbidden"):
        parse_canonical_json(b'{"a":1.0}\n')
    with pytest.raises(ProtocolError, match="json-constant-forbidden"):
        parse_canonical_json(b'{"a":NaN}\n')
    with pytest.raises(ProtocolError, match="wire-utf8-invalid"):
        parse_canonical_json(b'{"a":"\xff"}\n')
    # A decoded lone surrogate is not UTF-8 encodable canonical JSON.
    with pytest.raises(ProtocolError, match="wire-json-invalid"):
        parse_canonical_json(b'{"a":"\\ud800"}\n')


def test_parser_rejects_oversized_and_non_nfc_wire():
    with pytest.raises(ProtocolError, match="wire-size-invalid"):
        parse_canonical_json(b"{" + b" " * 40_000 + b"}\n")
    non_nfc = json.dumps({"label": "e\u0301"}, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
    with pytest.raises(ProtocolError, match="wire-unicode-not-nfc"):
        parse_canonical_json(non_nfc)


def test_enrollment_verifies_both_pinned_ed25519_signatures_and_observations(
    verifier, observations, keys
):
    result = verifier.verify_enrollment(
        _enrollment_wire(verifier, observations, keys), observed=observations, now=NOW + 1
    )
    assert result.enrollment is not None
    assert result.enrollment.observations == observations
    assert result.enrollment.capabilities == CAPABILITIES
    _assert_signed_content_free_receipt(result, keys)


@pytest.mark.parametrize(
    ("field", "changed", "code"),
    [
        ("butler_process_episode_hash", "foreign-butler-episode", "foreign-butler-process-episode"),
        ("costas_process_episode_hash", "foreign-costas-episode", "foreign-costas-process-episode"),
        ("host_instance_hash", "foreign-host", "foreign-host-instance"),
        ("executable_hash", "foreign-executable", "foreign-executable"),
        ("bundle_hash", "foreign-bundle", "foreign-bundle"),
        ("project_hash", "foreign-project", "foreign-project"),
        ("profile_hash", "foreign-profile", "foreign-profile"),
    ],
)
def test_claimed_measurement_never_replaces_injected_observation(
    verifier, observations, keys, field, changed, code
):
    wire = _enrollment_wire(verifier, observations, keys, **{field: _hash(changed)})
    result = verifier.verify_enrollment(wire, observed=observations, now=NOW + 1)
    assert result.enrollment is None
    assert result.receipt.code == code


def test_capability_observation_is_exact_and_arrays_are_sorted_unique_bounded(
    verifier, observations, keys
):
    changed = replace(observations, capabilities=("health",))
    result = verifier.verify_enrollment(
        _enrollment_wire(verifier, observations, keys), observed=changed, now=NOW + 1
    )
    assert result.receipt.code == "foreign-capabilities"

    for capabilities, code in [
        (["health", "events"], "capabilities-not-canonical"),
        (["health", "health"], "capabilities-not-canonical"),
        ([*CAPABILITIES, "mutate"], "capabilities-invalid"),
    ]:
        wire = _enrollment_wire(verifier, observations, keys, capabilities=capabilities)
        assert verifier.verify_enrollment(wire, observed=observations, now=NOW + 1).receipt.code == code


def test_enrollment_rejects_wrong_butler_pin_and_invalid_signatures(
    verifier, observations, keys
):
    wrong_key = _private(9)
    document = _enrollment_document(verifier, observations)
    wire = _sign_enrollment_document(
        document, butler_private_key=wrong_key, costas_private_key=keys[1]
    )
    result = verifier.verify_enrollment(wire, observed=observations, now=NOW + 1)
    assert result.receipt.code == "butler-signature-invalid"

    wire = _sign_enrollment_document(
        document, butler_private_key=keys[0], costas_private_key=wrong_key
    )
    result = verifier.verify_enrollment(wire, observed=observations, now=NOW + 1)
    assert result.receipt.code == "costas-proof-invalid"

    wire = _enrollment_wire(
        verifier, observations, keys, butler_key_id=key_id(wrong_key.public_key())
    )
    assert (
        verifier.verify_enrollment(wire, observed=observations, now=NOW + 1).receipt.code
        == "butler-key-not-pinned"
    )


def test_unkeyed_challenge_hash_and_provisional_host_proof_are_rejected(
    verifier, observations, keys
):
    document = _enrollment_document(verifier, observations)
    document["challenge_hash"] = _hash("public-challenge")
    wire = canonical_json_bytes(document)
    assert (
        verifier.verify_enrollment(wire, observed=observations, now=NOW + 1).receipt.code
        == "forbidden-field"
    )

    signed = json.loads(_enrollment_wire(verifier, observations, keys))
    signed["costas_proof"] = _hash("unkeyed-deterministic-host-proof")
    wire = canonical_json_bytes(signed)
    assert (
        verifier.verify_enrollment(wire, observed=observations, now=NOW + 1).receipt.code
        == "costas-proof-invalid"
    )


@pytest.mark.parametrize(
    "forbidden",
    [
        "aiagent",
        "provider_id",
        "session_id",
        "thread_id",
        "turn_id",
        "rpc_method",
        "observations",
        "observed_executable_hash",
    ],
)
def test_forbidden_authority_private_and_rpc_fields_refuse_at_any_depth(
    verifier, observations, keys, forbidden
):
    document = _enrollment_document(verifier, observations)
    document["extra"] = {forbidden: "not-admitted"}
    result = verifier.verify_enrollment(
        canonical_json_bytes(document), observed=observations, now=NOW + 1
    )
    assert result.receipt.code == "forbidden-field"


def test_closed_enrollment_shape_hash_bounds_and_ttl(verifier, observations, keys):
    document = json.loads(_enrollment_wire(verifier, observations, keys))
    document["extra"] = "x"
    assert (
        verifier.verify_enrollment(
            canonical_json_bytes(document), observed=observations, now=NOW + 1
        ).receipt.code
        == "enrollment-shape-invalid"
    )

    wire = _enrollment_wire(verifier, observations, keys, executable_hash="sha256:ABC")
    assert (
        verifier.verify_enrollment(wire, observed=observations, now=NOW + 1).receipt.code
        == "executable-hash-invalid"
    )

    wire = _enrollment_wire(verifier, observations, keys, expires_at=NOW + 901)
    assert verifier.verify_enrollment(wire, observed=observations, now=NOW + 1).receipt.code == "ttl-invalid"

    wire = _enrollment_wire(verifier, observations, keys, issued_at=NOW + 10)
    assert (
        verifier.verify_enrollment(wire, observed=observations, now=NOW + 1).receipt.code
        == "enrollment-time-invalid"
    )


def test_enrollment_nonce_replay_and_generation_are_committed_by_injected_state(
    verifier, observations, keys, state
):
    wire = _enrollment_wire(verifier, observations, keys)
    assert verifier.verify_enrollment(wire, observed=observations, now=NOW + 1).enrollment
    replay = verifier.verify_enrollment(wire, observed=observations, now=NOW + 1)
    assert replay.enrollment is None
    assert replay.receipt.code == "nonce-replay"
    assert state.enrollment_calls == 2

    fresh = _enrollment_wire(
        verifier,
        observations,
        keys,
        challenge_nonce="challenge-nonce-00000002",
        revocation_generation=GENERATION + 1,
    )
    revoked = verifier.verify_enrollment(fresh, observed=observations, now=NOW + 1)
    assert revoked.receipt.code == "revoked"


def test_all_and_only_closed_operations_parse_and_verify(verifier, observations, keys):
    enrollment = _verified_enrollment(verifier, observations, keys)
    for index, operation in enumerate(CAPABILITIES, start=1):
        scope = f"scope-{operation}"
        wire = _command_wire(
            verifier,
            enrollment,
            observations,
            keys,
            operation,
            sequence=1,
            nonce=f"command-nonce-{index:016d}",
            scope=scope,
        )
        result = verifier.verify_command(
            wire, enrollment=enrollment, observed=observations, now=NOW + 2
        )
        assert isinstance(result.command, CommandClaim)
        assert result.command.document["operation"] == operation
        assert result.receipt.status == "verified-not-run"
        _assert_signed_content_free_receipt(result, keys)

    document = _command_document(verifier, enrollment.enrollment_hash, observations)
    document["operation"] = "spawn"
    wire = _sign_command_document(document, butler_private_key=keys[0])
    result = verifier.verify_command(wire, enrollment=enrollment, observed=observations, now=NOW + 2)
    assert result.command is None
    assert result.receipt.code == "operation-unsupported"


@pytest.mark.parametrize(
    ("operation", "payload_update", "expected"),
    [
        ("events", {"limit": 0}, "limit-invalid"),
        ("events", {"limit": MAX_EVENT_PAGE + 1}, "event-page-bounds"),
        ("health", {"extra": _hash("extra")}, "payload-shape-invalid"),
        ("steer", {"active_turn_hash": "raw-turn-id"}, "active-turn-hash-invalid"),
    ],
)
def test_payloads_are_operation_typed_closed_and_bounded(
    verifier, observations, keys, operation, payload_update, expected
):
    enrollment = _verified_enrollment(verifier, observations, keys)
    document = _command_document(
        verifier, enrollment.enrollment_hash, observations, operation
    )
    document["payload"].update(payload_update)
    wire = _sign_command_document(document, butler_private_key=keys[0])
    result = verifier.verify_command(wire, enrollment=enrollment, observed=observations, now=NOW + 2)
    assert result.receipt.code == expected


def test_spawn_scope_and_observed_project_profile_are_exact(verifier, observations, keys):
    enrollment = _verified_enrollment(verifier, observations, keys)
    document = _command_document(
        verifier, enrollment.enrollment_hash, observations, "spawn_read_only"
    )
    document["command_scope_hash"] = _hash("different-dispatch")
    wire = _sign_command_document(document, butler_private_key=keys[0])
    assert (
        verifier.verify_command(
            wire, enrollment=enrollment, observed=observations, now=NOW + 2
        ).receipt.code
        == "command-scope-mismatch"
    )

    for field, expected in [("project_hash", "foreign-project"), ("profile_hash", "foreign-profile")]:
        document = _command_document(
            verifier, enrollment.enrollment_hash, observations, "spawn_read_only"
        )
        document["payload"][field] = _hash(f"foreign-{field}")
        wire = _sign_command_document(document, butler_private_key=keys[0])
        result = verifier.verify_command(
            wire, enrollment=enrollment, observed=observations, now=NOW + 2
        )
        assert result.receipt.code == expected


def test_command_requires_pinned_signature_enrollment_generation_and_live_observations(
    verifier, observations, keys
):
    enrollment = _verified_enrollment(verifier, observations, keys)
    document = _command_document(verifier, enrollment.enrollment_hash, observations)
    wire = _sign_command_document(document, butler_private_key=_private(9))
    assert (
        verifier.verify_command(
            wire, enrollment=enrollment, observed=observations, now=NOW + 2
        ).receipt.code
        == "butler-signature-invalid"
    )

    foreign_enrollment = replace(enrollment, enrollment_hash=_hash("foreign-enrollment"))
    wire = _sign_command_document(document, butler_private_key=keys[0])
    assert (
        verifier.verify_command(
            wire, enrollment=foreign_enrollment, observed=observations, now=NOW + 2
        ).receipt.code
        == "foreign-enrollment"
    )

    changed = replace(observations, executable_hash=_hash("replaced-executable"))
    assert (
        verifier.verify_command(wire, enrollment=enrollment, observed=changed, now=NOW + 2).receipt.code
        == "observation-changed"
    )

    document["revocation_generation"] += 1
    wire = _sign_command_document(document, butler_private_key=keys[0])
    assert (
        verifier.verify_command(
            wire, enrollment=enrollment, observed=observations, now=NOW + 2
        ).receipt.code
        == "revocation-generation-mismatch"
    )


def test_command_ttl_is_at_most_900_and_bounded_by_enrollment(verifier, observations, keys):
    enrollment = _verified_enrollment(verifier, observations, keys)
    document = _command_document(verifier, enrollment.enrollment_hash, observations)
    document["expires_at"] = document["issued_at"] + 901
    wire = _sign_command_document(document, butler_private_key=keys[0])
    assert (
        verifier.verify_command(
            wire, enrollment=enrollment, observed=observations, now=NOW + 2
        ).receipt.code
        == "ttl-invalid"
    )

    document["expires_at"] = enrollment.expires_at + 1
    wire = _sign_command_document(document, butler_private_key=keys[0])
    assert (
        verifier.verify_command(
            wire, enrollment=enrollment, observed=observations, now=NOW + 2
        ).receipt.code
        == "command-time-invalid"
    )


def test_command_sequence_nonce_and_duplicate_are_atomic_via_injected_cas(
    verifier, observations, keys, state
):
    enrollment = _verified_enrollment(verifier, observations, keys)
    first_wire = _command_wire(verifier, enrollment, observations, keys)
    first = verifier.verify_command(
        first_wire, enrollment=enrollment, observed=observations, now=NOW + 2
    )
    assert first.command is not None

    duplicate = verifier.verify_command(
        first_wire, enrollment=enrollment, observed=observations, now=NOW + 2
    )
    assert duplicate.command is None
    assert duplicate.receipt.status == "duplicate"
    assert duplicate.receipt.code == "duplicate-request"

    gap_wire = _command_wire(
        verifier,
        enrollment,
        observations,
        keys,
        sequence=3,
        nonce="command-nonce-gap-000001",
    )
    gap = verifier.verify_command(
        gap_wire, enrollment=enrollment, observed=observations, now=NOW + 2
    )
    assert gap.receipt.code == "sequence-conflict"

    replay_wire = _command_wire(
        verifier,
        enrollment,
        observations,
        keys,
        operation="health",
        sequence=2,
        nonce="command-nonce-0000000001",
    )
    replay = verifier.verify_command(
        replay_wire, enrollment=enrollment, observed=observations, now=NOW + 2
    )
    assert replay.receipt.code == "nonce-replay"
    assert state.command_calls == 4


def test_sequence_is_independent_per_enrollment_and_runtime_binding(
    verifier, observations, keys
):
    enrollment = _verified_enrollment(verifier, observations, keys)
    for index, scope in enumerate(("runtime-one", "runtime-two"), start=1):
        wire = _command_wire(
            verifier,
            enrollment,
            observations,
            keys,
            sequence=1,
            nonce=f"scope-command-nonce-{index:08d}",
            scope=scope,
        )
        assert verifier.verify_command(
            wire, enrollment=enrollment, observed=observations, now=NOW + 2
        ).command


def test_outcome_unknown_is_typed_and_never_reverified_as_runnable(
    verifier, observations, keys, state
):
    enrollment = _verified_enrollment(verifier, observations, keys)
    state.next_command_decision = StateDecision.OUTCOME_UNKNOWN
    result = verifier.verify_command(
        _command_wire(verifier, enrollment, observations, keys),
        enrollment=enrollment,
        observed=observations,
        now=NOW + 2,
    )
    assert result.command is None
    assert result.receipt.status == "outcome-unknown"
    assert result.receipt.code == "prior-outcome-unavailable"
    _assert_signed_content_free_receipt(result, keys)


def test_cas_write_ambiguity_returns_outcome_unknown_not_runnable(
    verifier, observations, keys, state
):
    enrollment = _verified_enrollment(verifier, observations, keys)
    state.raise_command_error = True
    result = verifier.verify_command(
        _command_wire(verifier, enrollment, observations, keys),
        enrollment=enrollment,
        observed=observations,
        now=NOW + 2,
    )
    assert result.command is None
    assert result.receipt.status == "outcome-unknown"
    assert result.receipt.code == "prior-outcome-unavailable"


def test_parse_functions_have_no_effect_or_ambient_observation_dependency(
    verifier, observations, keys
):
    enrollment_wire = _enrollment_wire(verifier, observations, keys)
    parsed_enrollment = parse_enrollment(enrollment_wire)
    assert parsed_enrollment.canonical_bytes == enrollment_wire

    enrollment = _verified_enrollment(verifier, observations, keys)
    command_wire = _command_wire(verifier, enrollment, observations, keys)
    parsed_command = parse_command(command_wire)
    assert parsed_command.canonical_bytes == command_wire
    assert not hasattr(parsed_command, "execute")
    assert not hasattr(verifier, "endpoint")
    assert not hasattr(verifier, "runtime")


def test_receipt_signature_detects_tampering(verifier, observations, keys):
    result = verifier.verify_enrollment(
        _enrollment_wire(verifier, observations, keys), observed=observations, now=NOW + 1
    )
    tampered = copy.deepcopy(result.receipt.document)
    tampered["code"] = "verified-and-run"
    object.__setattr__(result.receipt, "document", tampered)
    assert not verify_receipt_signature(result.receipt, keys[2].public_key())
