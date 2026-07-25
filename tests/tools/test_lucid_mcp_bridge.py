import sys

from tools.lucid_mcp_bridge import (
    HOST_CONTEXT_EXTENSION,
    lucid_retry_disposition,
    lucid_host_context_meta,
    project_lucid_receipt,
    public_lucid_bridge_status,
)


def test_exact_first_party_lucid_stdio_receives_bounded_host_identity(monkeypatch):
    args = {"path": "fleet"}
    butler = "/Applications/Catalyst.app/Contents/Resources/ae/butler"
    monkeypatch.setenv("HERMES_LUCID_BUTLER_PATH", butler)
    meta = lucid_host_context_meta(
        "lucid-quine",
        {"command": "butler", "args": ["--mcp-stdio"]},
        session_id="session:desktop-123",
        resolved_command=butler,
    )

    assert meta == {
        HOST_CONTEXT_EXTENSION: {"session_id": "session:desktop-123"}
    }
    assert args == {"path": "fleet"}, "host enrichment must not mutate model arguments"


def test_non_lucid_or_noncanonical_transports_never_receive_metadata(monkeypatch):
    butler = "/Applications/Catalyst.app/Contents/Resources/ae/butler"
    monkeypatch.setenv("HERMES_LUCID_BUTLER_PATH", butler)
    cases = [
        ("other", {"command": "butler", "args": ["--mcp-stdio"]}),
        ("lucid-quine", {"command": "python", "args": ["server.py"]}),
        ("lucid-quine", {"command": "butler", "args": ["--mcp-stdio", "--extra"]}),
        ("lucid-quine", {"url": "https://example.test/mcp"}),
    ]
    for name, config in cases:
        assert lucid_host_context_meta(
            name, config, session_id="session:ok", resolved_command=butler
        ) is None


def test_same_name_path_impersonation_fails_closed(monkeypatch):
    admitted = "/Applications/Catalyst.app/Contents/Resources/ae/butler"
    monkeypatch.setenv("HERMES_LUCID_BUTLER_PATH", admitted)
    assert lucid_host_context_meta(
        "lucid-quine",
        {"command": "butler", "args": ["--mcp-stdio"]},
        session_id="session:ok",
        resolved_command="/tmp/attacker/butler",
    ) is None


def test_malformed_or_unbounded_session_identity_fails_closed(monkeypatch):
    butler = "/Applications/Catalyst.app/Contents/Resources/ae/butler"
    monkeypatch.setenv("HERMES_LUCID_BUTLER_PATH", butler)
    config = {"command": "butler", "args": ["--mcp-stdio"]}
    for value in (None, "", " leading", "contains space", "x" * 193, "💥"):
        assert lucid_host_context_meta(
            "lucid-quine",
            config,
            session_id=value,
            resolved_command=butler,
        ) is None


def test_public_status_is_content_free_and_names_authority_owner(monkeypatch):
    monkeypatch.setenv("HERMES_LUCID_BUTLER_PATH", sys.executable)
    status = public_lucid_bridge_status(
        "lucid-quine", {"command": "butler", "args": ["--mcp-stdio"]}
    )
    assert status == {
        "schema": "hermes-lucid-host-bridge/1",
        "server": "lucid-quine",
        "transport_admitted": True,
        "identity_binding": "request-scoped",
        "authority": "butler-capability-required",
        "capability_material_exposed": False,
        "arguments_mutated": False,
        "receipt_owner": "Butler/Envelope",
    }
    wire = repr(status).lower()
    assert "signature" not in wire
    assert "token" not in wire
    assert "session:" not in wire


def test_lucid_receipt_projection_is_closed_and_content_free():
    digest = "sha256:" + "a" * 64
    structured = {
        "envelope": {
            "intent": {
                "verb": "dispatch",
                "args": {"intent": "private prose", "secret": "must-not-project"},
            },
            "capability": {"signature": "must-not-project"},
            "escalation": {"needs_user": True, "reason": "private reason"},
            "fidelity": {"level": "degraded", "preserved": [], "lost": []},
            "refusal": {"code": "no-capability", "reason": "private reason"},
            "receipt": {
                "id": "lucid:abcdef0123456789",
                "ts": "2026-07-25T20:00:00Z",
                "trust": "untrusted",
                "content_hash": digest,
                "ran": False,
                "effect": "private effect text",
            },
        },
        "result": {"private": "must-not-project"},
        "future_field": "must-not-project",
    }

    receipt = project_lucid_receipt(structured)

    assert receipt == {
        "schema": "hermes-lucid-receipt/1",
        "id": "lucid:abcdef0123456789",
        "timestamp": "2026-07-25T20:00:00Z",
        "verb": "dispatch",
        "ran": False,
        "trust": "untrusted",
        "content_hash": digest,
        "refusal_code": "no-capability",
        "needs_user": True,
    }
    wire = repr(receipt).lower()
    for forbidden in (
        "must-not-project",
        "private prose",
        "private reason",
        "private effect text",
        "signature",
        "'result'",
        "'reason'",
    ):
        assert forbidden not in wire


def test_lucid_receipt_projection_rejects_malformed_or_open_shapes():
    valid_hash = "sha256:" + "b" * 64
    base = {
        "envelope": {
            "intent": {"verb": "get", "args": {}},
            "capability": None,
            "escalation": None,
            "fidelity": {"level": "lossless", "preserved": [], "lost": []},
            "refusal": None,
            "receipt": {
                "id": "lucid:abc",
                "ts": "2026-07-25T20:00:00Z",
                "trust": "verified",
                "content_hash": valid_hash,
                "ran": True,
                "effect": "ok",
            },
        }
    }
    assert project_lucid_receipt(base) is not None
    for mutate in (
        lambda d: d["envelope"]["intent"].update(verb="unknown"),
        lambda d: d["envelope"]["receipt"].update(id="contains space"),
        lambda d: d["envelope"]["receipt"].update(trust="superuser"),
        lambda d: d["envelope"]["receipt"].update(content_hash="sha256:short"),
        lambda d: d["envelope"]["receipt"].update(ran="yes"),
        lambda d: d["envelope"].update(refusal={"code": "open-ended", "reason": "x"}),
    ):
        import copy

        candidate = copy.deepcopy(base)
        mutate(candidate)
        assert project_lucid_receipt(candidate) is None


def test_retry_disposition_is_read_only_and_exact_provenance(monkeypatch):
    butler = "/Applications/Catalyst.app/Contents/Resources/ae/butler"
    monkeypatch.setenv("HERMES_LUCID_BUTLER_PATH", butler)
    config = {"command": "butler", "args": ["--mcp-stdio"]}

    assert (
        lucid_retry_disposition(
            "lucid-quine", config, "lucid.get", resolved_command=butler
        )
        == "retry-safe-read"
    )
    for verb in ("show", "set", "morph", "dispatch", "steer", "cancel"):
        assert (
            lucid_retry_disposition(
                "lucid-quine",
                config,
                f"lucid.{verb}",
                resolved_command=butler,
            )
            == "outcome-unknown"
        )
    assert (
        lucid_retry_disposition(
            "foreign", config, "lucid.dispatch", resolved_command=butler
        )
        is None
    )
    assert (
        lucid_retry_disposition(
            "lucid-quine",
            config,
            "lucid.dispatch",
            resolved_command="/tmp/attacker/butler",
        )
        is None
    )
