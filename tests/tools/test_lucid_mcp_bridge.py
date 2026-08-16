from tools.lucid_mcp_bridge import (
    HOST_CONTEXT_EXTENSION,
    LUCID_MCP_URL,
    lucid_exact_confirmation,
    lucid_host_context_meta,
    lucid_outcome_unknown,
    lucid_retry_disposition,
    project_lucid_receipt,
    project_lucid_tool_result,
    public_lucid_bridge_status,
)


def test_exact_first_party_lucid_endpoint_receives_bounded_host_identity():
    args = {"path": "fleet"}
    meta = lucid_host_context_meta(
        "lucid-quine",
        {"url": LUCID_MCP_URL},
        session_id="11111111-1111-4111-8111-111111111111",
    )

    assert meta == {
        HOST_CONTEXT_EXTENSION: {
            "session_id": "11111111-1111-4111-8111-111111111111",
            "authority": "none",
        }
    }
    assert args == {"path": "fleet"}, "host enrichment must not mutate model arguments"


def test_non_lucid_or_noncanonical_transports_never_receive_metadata():
    cases = [
        ("other", {"command": "butler", "args": ["--mcp-stdio"]}),
        ("lucid-quine", {"command": "python", "args": ["server.py"]}),
        ("lucid-quine", {"command": "butler", "args": ["--mcp-stdio"]}),
        ("lucid-quine", {"url": "http://localhost:4176/mcp"}),
        ("lucid-quine", {"url": "https://example.test/mcp"}),
    ]
    for name, config in cases:
        assert lucid_host_context_meta(
            name, config, session_id="33333333-3333-4333-8333-333333333333"
        ) is None


def test_canonical_url_with_process_fields_fails_closed():
    assert lucid_host_context_meta(
        "lucid-quine",
        {"url": LUCID_MCP_URL, "command": "butler"},
        session_id="33333333-3333-4333-8333-333333333333",
    ) is None


def test_malformed_or_unbounded_session_identity_fails_closed():
    config = {"url": LUCID_MCP_URL}
    for value in (None, "", " leading", "contains space", "x" * 193, "💥"):
        assert lucid_host_context_meta(
            "lucid-quine",
            config,
            session_id=value,
        ) is None


def test_public_status_is_content_free_and_names_authority_owner():
    status = public_lucid_bridge_status("lucid-quine", {"url": LUCID_MCP_URL})
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


def test_retry_disposition_is_read_only_and_exact_provenance():
    config = {"url": LUCID_MCP_URL}

    assert (
        lucid_retry_disposition("lucid-quine", config, "lucid.get")
        == "retry-safe-read"
    )
    for verb in ("show", "set", "morph", "dispatch", "steer", "cancel"):
        assert (
            lucid_retry_disposition(
                "lucid-quine",
                config,
                f"lucid.{verb}",
            )
            == "outcome-unknown"
        )
    assert (
        lucid_retry_disposition("foreign", config, "lucid.dispatch")
        is None
    )
    assert (
        lucid_retry_disposition(
            "lucid-quine",
            {"url": "http://localhost:4176/mcp"},
            "lucid.dispatch",
        )
        is None
    )


def test_exact_confirmation_is_host_bound_and_never_accepts_a_caller_digest():
    arguments = {"id": "dispatch:" + "a" * 64, "mode": "graceful"}
    confirmation = lucid_exact_confirmation("cancel", arguments, confirmed=True)

    assert confirmation is not None
    assert confirmation["schema"] == "lucid-exact-confirmation/1"
    assert confirmation["verb"] == "cancel"
    assert confirmation["arguments_hash"].startswith("sha256:")
    assert lucid_exact_confirmation("cancel", arguments, confirmed=False) is None
    assert lucid_exact_confirmation("dispatch", arguments, confirmed=True) is None
    assert lucid_host_context_meta(
        "lucid-quine",
        {"url": LUCID_MCP_URL},
        session_id="44444444-4444-4444-8444-444444444444",
        exact_confirmation=confirmation,
    ) == {
        HOST_CONTEXT_EXTENSION: {
            "session_id": "44444444-4444-4444-8444-444444444444",
            "authority": "none",
            "exact_confirmation": confirmation,
        }
    }


def test_closed_tool_result_parsing_requires_matching_receipt_and_result():
    digest = "sha256:" + "c" * 64
    structured = {
        "envelope": {
            "intent": {"verb": "get", "args": {"private": "omitted"}},
            "capability": None,
            "escalation": None,
            "fidelity": {"level": "lossless", "preserved": [], "lost": []},
            "refusal": None,
            "receipt": {
                "id": "lucid:result",
                "ts": "2026-07-27T01:02:03Z",
                "trust": "verified",
                "content_hash": digest,
                "ran": True,
                "effect": "private",
            },
        },
        "result": {"status": "ok"},
    }

    projected = project_lucid_tool_result(
        structured, expected_verb="get", is_error=False
    )
    assert projected["result"] == {"status": "ok"}
    receipt = projected["lucid_receipt"]
    assert isinstance(receipt, dict)
    assert receipt["schema"] == "hermes-lucid-receipt/1"
    assert "envelope" not in repr(projected).lower()
    assert project_lucid_tool_result(
        structured, expected_verb="show", is_error=False
    ) == {
        "error": "Butler returned an invalid LUCID success receipt",
        "code": "lucid-invalid-receipt",
        "retryable": False,
    }


def test_consequential_unknown_outcome_is_closed_and_nonretryable():
    assert lucid_outcome_unknown("dispatch") == {
        "error": "LUCID call outcome is unknown; automatic retry is disabled",
        "code": "lucid-outcome-unknown",
        "retryable": False,
        "server": "lucid-quine",
        "tool": "lucid.dispatch",
    }
    assert lucid_outcome_unknown("get")["code"] == "lucid-invalid-request"
