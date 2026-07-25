import sys

from tools.lucid_mcp_bridge import (
    HOST_CONTEXT_EXTENSION,
    lucid_host_context_meta,
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
