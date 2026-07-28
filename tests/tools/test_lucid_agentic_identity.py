from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from gateway.session_context import (
    bind_lucid_conversation_id,
    bind_lucid_role,
    get_lucid_conversation_id,
    reset_lucid_conversation_id,
    reset_lucid_role,
)
from tools import mcp_tool
from tools.lucid_mcp_bridge import (
    HOST_CONTEXT_EXTENSION,
    current_lucid_host_context_meta,
    lucid_signin_request,
)

BUTLER = "/Applications/Catalyst.app/Contents/Resources/ae/butler"
CONFIG = {"command": "butler", "args": ["--mcp-stdio"]}
AMBIENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
EXPLICIT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def _result(verb: str, result: object) -> SimpleNamespace:
    return SimpleNamespace(
        isError=False,
        content=[],
        structuredContent={
            "envelope": {
                "intent": {"verb": verb, "args": {}},
                "capability": None,
                "escalation": None,
                "fidelity": {"level": "lossless", "preserved": [], "lost": []},
                "refusal": None,
                "receipt": {
                    "id": f"lucid:{verb}-ok",
                    "ts": "2026-07-27T12:00:00Z",
                    "trust": "verified",
                    "content_hash": "sha256:" + "a" * 64,
                    "ran": True,
                    "effect": "private",
                },
            },
            "result": result,
        },
    )


def _server(*results: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(
        session=SimpleNamespace(call_tool=AsyncMock(side_effect=list(results))),
        _config=dict(CONFIG),
        _resolved_command=BUTLER,
        _rpc_lock=asyncio.Lock(),
        _pending_call_context=None,
        _is_recycled_stdio=lambda: False,
        _mark_session_proven=lambda: None,
        mark_tool_call=lambda: None,
        tool_timeout=30.0,
    )


def _run_direct(coro_or_factory, timeout=30):
    del timeout
    coro = coro_or_factory() if callable(coro_or_factory) else coro_or_factory
    return asyncio.run(coro)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.setenv("HERMES_LUCID_BUTLER_PATH", BUTLER)
    monkeypatch.setenv("HERMES_LUCID_ROLE", "EM")
    token = bind_lucid_conversation_id(AMBIENT)
    try:
        yield
    finally:
        reset_lucid_conversation_id(token)
        mcp_tool._servers.pop("lucid-quine", None)
        mcp_tool._server_error_counts.pop("lucid-quine", None)


def test_explicit_handler_identity_wins_over_contextvar_fallback():
    assert get_lucid_conversation_id() == AMBIENT
    meta = current_lucid_host_context_meta(
        "lucid-quine",
        CONFIG,
        conversation_id=EXPLICIT,
        resolved_command=BUTLER,
    )
    assert meta == {
        HOST_CONTEXT_EXTENSION: {"session_id": EXPLICIT, "authority": "none"}
    }


def test_contextvar_identity_is_used_when_handler_has_no_explicit_value():
    meta = current_lucid_host_context_meta(
        "lucid-quine", CONFIG, resolved_command=BUTLER
    )
    assert meta == {
        HOST_CONTEXT_EXTENSION: {"session_id": AMBIENT, "authority": "none"}
    }


def test_invalid_explicit_identity_fails_closed_instead_of_using_ambient():
    assert current_lucid_host_context_meta(
        "lucid-quine",
        CONFIG,
        conversation_id="not-a-uuid",
        resolved_command=BUTLER,
    ) is None


def test_missing_identity_returns_typed_unsigned_posture_without_calling_butler(
    monkeypatch,
):
    missing_token = bind_lucid_conversation_id(None)
    server = _server(_result("get", "should-not-run"))
    mcp_tool._servers["lucid-quine"] = server  # type: ignore[assignment]
    monkeypatch.setattr(mcp_tool, "_run_on_mcp_loop", _run_direct)

    try:
        output = json.loads(
            mcp_tool._make_tool_handler("lucid-quine", "lucid.get", 30.0)(
                {"path": "fleet"}, conversation_id="invalid"
            )
        )
    finally:
        reset_lucid_conversation_id(missing_token)

    assert output == {
        "error": "LUCID conversation identity is unavailable",
        "code": "lucid-unsigned",
        "retryable": False,
        "authority": "none",
    }
    server.session.call_tool.assert_not_awaited()
    assert "usage:" not in json.dumps(output).lower()


def test_signin_request_is_closed_and_contains_no_authority_material():
    request = lucid_signin_request()
    assert request == {"action": "signin", "path": "role-session"}
    wire = json.dumps(request).lower()
    for forbidden in (
        "capability",
        "token",
        "signature",
        "grant",
        "broker",
        "key",
        "scope",
        "session_id",
    ):
        assert forbidden not in wire


def test_host_signin_then_ordinary_call_crosses_only_identity_metadata(monkeypatch):
    server = _server(_result("set", {"status": "signed-in"}), _result("get", {"ok": True}))
    mcp_tool._servers["lucid-quine"] = server  # type: ignore[assignment]
    monkeypatch.setattr(mcp_tool, "_run_on_mcp_loop", _run_direct)

    signed_in = json.loads(
        mcp_tool.invoke_lucid_bootstrap_signin(conversation_id=EXPLICIT)
    )
    ordinary = json.loads(
        mcp_tool._make_tool_handler("lucid-quine", "lucid.get", 30.0)(
            {"path": "fleet"}, conversation_id=EXPLICIT
        )
    )

    assert signed_in["result"] == {"status": "signed-in"}
    assert ordinary["result"] == {"ok": True}
    calls = server.session.call_tool.await_args_list
    assert calls[0].args == ("lucid.set",)
    assert calls[0].kwargs == {
        "arguments": {"action": "signin", "path": "role-session"},
        "meta": {
            HOST_CONTEXT_EXTENSION: {
                "session_id": EXPLICIT,
                "authority": "none",
                "bootstrap": {
                    "schema": "hermes-lucid-bootstrap-decision/1",
                    "action": "signin",
                    "role": "EM",
                    "role_session_id": EXPLICIT,
                },
            }
        },
    }
    assert calls[1].args == ("lucid.get",)
    assert calls[1].kwargs == {
        "arguments": {"path": "fleet"},
        "meta": {
            HOST_CONTEXT_EXTENSION: {
                "session_id": EXPLICIT,
                "authority": "none",
            }
        },
    }
    crossing = json.dumps([call.kwargs for call in calls]).lower()
    for forbidden in ("localcapability", "token", "signature", "grant", "broker key"):
        assert forbidden not in crossing


def test_explicit_sidekick_binding_overrides_process_em_for_bootstrap(monkeypatch):
    server = _server(_result("set", {"status": "signed-in"}))
    mcp_tool._servers["lucid-quine"] = server  # type: ignore[assignment]
    monkeypatch.setattr(mcp_tool, "_run_on_mcp_loop", _run_direct)
    role_token = bind_lucid_role("SIDEKICK")
    try:
        result = json.loads(
            mcp_tool.invoke_lucid_bootstrap_signin(conversation_id=EXPLICIT)
        )
    finally:
        reset_lucid_role(role_token)

    assert result["result"] == {"status": "signed-in"}
    bootstrap = server.session.call_tool.await_args.kwargs["meta"][
        HOST_CONTEXT_EXTENSION
    ]["bootstrap"]
    assert bootstrap == {
        "schema": "hermes-lucid-bootstrap-decision/1",
        "action": "signin",
        "role": "SIDEKICK",
        "role_session_id": EXPLICIT,
    }
