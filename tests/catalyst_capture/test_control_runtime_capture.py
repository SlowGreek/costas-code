"""Mechanical fake-wire captures for the Catalyst control/runtime oracle cells.

The capture builders below execute the current AIAgent and Codex app-server
session/client implementations.  They do not use the oracle's ``expected``
objects to construct observations; the oracle is loaded only after capture so
that independently observed states can be compared with the semantic contract.
"""
from __future__ import annotations

import json
import queue
import threading
from pathlib import Path
from typing import Any, Callable, Optional, cast

from agent.transports.codex_app_server import (
    CodexAppServerClient,
    CodexAppServerError,
)
from agent.transports.codex_app_server_session import CodexAppServerSession
from run_agent import AIAgent

ROOT = Path(__file__).resolve().parents[2]
ORACLE_PATH = ROOT / "tests" / "fixtures" / "catalyst_oracle" / "corpus.json"
CAPTURE_PATH = (
    ROOT
    / "tests"
    / "fixtures"
    / "catalyst_oracle"
    / "captured"
    / "control_runtime.json"
)
CAPTURE_CASE_IDS = (
    "control-steer-exact",
    "control-interrupt-exact",
    "control-stale-foreign-refusal",
    "runtime-compaction",
    "runtime-provider-unavailable",
    "session-resume-unavailable",
    "runtime-replay-unavailable",
    "runtime-close-proof-unavailable",
)


def _canonical(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        + "\n"
    ).encode("utf-8")


class FakeWireClient:
    """Small protocol fake which records requests and serves queued events."""

    def __init__(
        self,
        request_handler: Optional[Callable[[str, dict[str, Any]], dict[str, Any]]] = None,
    ) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.notifications: list[dict[str, Any]] = []
        self.request_handler = request_handler
        self.initialized = False
        self.closed = False
        self.close_calls = 0

    def initialize(self, **_kwargs: Any) -> dict[str, Any]:
        self.initialized = True
        return {"userAgent": "fake-wire/1"}

    def request(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        del timeout
        request_params = params or {}
        self.requests.append((method, request_params))
        if self.request_handler is not None:
            return self.request_handler(method, request_params)
        if method == "thread/start":
            return {"thread": {"id": "thread-1"}}
        if method == "turn/start":
            return {"turn": {"id": "turn-1"}}
        if method == "turn/steer":
            return {"turnId": request_params.get("expectedTurnId")}
        return {}

    def take_notification(self, timeout: float = 0.0) -> Optional[dict[str, Any]]:
        del timeout
        return self.notifications.pop(0) if self.notifications else None

    def take_server_request(self, timeout: float = 0.0) -> None:
        del timeout
        return None

    def respond(self, _request_id: Any, _result: dict[str, Any]) -> None:
        return None

    def respond_error(
        self,
        _request_id: Any,
        _code: int,
        _message: str,
        data: Any = None,
    ) -> None:
        del data
        return None

    def stderr_tail(self, n: int = 20) -> list[str]:
        del n
        return []

    def is_alive(self) -> bool:
        return not self.closed

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True

    def queue_notification(self, method: str, **params: Any) -> None:
        self.notifications.append({"method": method, "params": params})


def _session(client: FakeWireClient) -> CodexAppServerSession:
    return CodexAppServerSession(
        cwd="/workspace",
        client_factory=cast(Any, lambda **_kwargs: client),
    )


def _bare_codex_agent(session: CodexAppServerSession) -> AIAgent:
    """Build only the state used by AIAgent.redirect()/interrupt()."""
    agent = AIAgent.__new__(AIAgent)
    state = cast(Any, agent)
    state.api_mode = "codex_app_server"
    state._codex_session = session
    state._pending_redirect_lock = threading.Lock()
    state._pending_redirect = None
    state._interrupt_requested = False
    state._interrupt_message = None
    state._execution_thread_id = None
    state._interrupt_thread_signal_pending = False
    state._tool_worker_threads = set()
    state._tool_worker_threads_lock = threading.Lock()
    state._active_children = set()
    state._active_children_lock = threading.Lock()
    state.quiet_mode = True
    return agent


def _case(
    case_id: str,
    *,
    availability: str,
    request_acceptance: str,
    runtime_terminal_candidate: bool,
    final_state: str,
    refusal: Optional[str],
    evidence: dict[str, Any],
) -> dict[str, Any]:
    return {
        "availability": availability,
        "evidence": evidence,
        "final_state": final_state,
        "id": case_id,
        "product_acceptance": False,
        "refusal": refusal,
        "request_acceptance": request_acceptance,
        "runtime_terminal_candidate": runtime_terminal_candidate,
    }


def _capture_exact_steer() -> dict[str, Any]:
    client = FakeWireClient()
    session = _session(client)
    session.ensure_started()
    with session._active_turn_lock:
        session._active_turn_id = "turn-1"
    agent = _bare_codex_agent(session)

    accepted = agent.redirect("  synthetic correction  ")
    method, params = client.requests[-1]
    with session._active_turn_lock:
        active_turn_unchanged = session._active_turn_id == "turn-1"
    exact_target = (
        method == "turn/steer"
        and params.get("threadId") == "thread-1"
        and params.get("expectedTurnId") == "turn-1"
    )
    raw_input = params.get("input")
    input_items: list[Any] = raw_input if isinstance(raw_input, list) else []
    observed = accepted and exact_target and active_turn_unchanged

    return _case(
        "control-steer-exact",
        availability="wired",
        request_acceptance="accepted" if accepted else "refused",
        runtime_terminal_candidate=False,
        final_state="active-steered" if observed else "unchanged",
        refusal=None if observed else "steer-not-accepted",
        evidence={
            "active_turn_unchanged": active_turn_unchanged,
            "expected_turn_bound": exact_target,
            "input_item_count": len(input_items),
            "rpc": method,
        },
    )


def _capture_interrupt_request() -> dict[str, Any]:
    client = FakeWireClient()
    session = _session(client)
    agent = _bare_codex_agent(session)

    def request_handler(method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method == "thread/start":
            return {"thread": {"id": "thread-1"}}
        if method == "turn/start":
            agent.interrupt()
            agent.interrupt()
            return {"turn": {"id": "turn-1"}}
        return {}

    client.request_handler = request_handler
    result = session.run_turn(
        "synthetic request",
        turn_timeout=0.1,
        notification_poll_timeout=0.0,
    )
    interrupt_requests = [
        params for method, params in client.requests if method == "turn/interrupt"
    ]
    exact_target = interrupt_requests == [
        {"threadId": "thread-1", "turnId": "turn-1"}
    ]
    requested = result.interrupted and exact_target

    return _case(
        "control-interrupt-exact",
        availability="wired",
        request_acceptance="requested" if requested else "refused",
        runtime_terminal_candidate=False,
        final_state="interrupt-pending" if requested else "unchanged",
        refusal=None if requested else "interrupt-not-requested",
        evidence={
            "exact_target_bound": exact_target,
            "idempotent_wire_request_count": len(interrupt_requests),
            "runtime_terminal_observed": False,
            "turn_result_interrupted": result.interrupted,
        },
    )


def _capture_stale_foreign_refusal() -> dict[str, Any]:
    def request_handler(method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method == "thread/start":
            return {"thread": {"id": "thread-1"}}
        if method == "turn/steer":
            return {"turnId": "turn-foreign"}
        return {}

    client = FakeWireClient(request_handler)
    session = _session(client)
    session.ensure_started()
    with session._active_turn_lock:
        session._active_turn_id = "turn-1"

    accepted = session.request_steer("synthetic stale guidance")
    method, params = client.requests[-1]
    with session._active_turn_lock:
        active_turn_unchanged = session._active_turn_id == "turn-1"
    exact_request_target = (
        method == "turn/steer"
        and params.get("threadId") == "thread-1"
        and params.get("expectedTurnId") == "turn-1"
    )
    refused = not accepted and active_turn_unchanged

    return _case(
        "control-stale-foreign-refusal",
        availability="wired",
        request_acceptance="refused" if refused else "accepted",
        runtime_terminal_candidate=False,
        final_state="unchanged" if refused else "active-steered",
        refusal="stale-or-foreign-target" if refused else None,
        evidence={
            "active_turn_unchanged": active_turn_unchanged,
            "request_target_was_exact": exact_request_target,
            "response_target_matched": accepted,
            "rpc": method,
        },
    )


def _capture_compaction() -> dict[str, Any]:
    observed_methods: list[str] = []
    client = FakeWireClient()
    client.queue_notification(
        "turn/started",
        threadId="thread-foreign",
        turn={"id": "compact-turn-foreign"},
    )
    client.queue_notification(
        "turn/completed",
        threadId="thread-1",
        turn={"id": "compact-turn-stale", "status": "completed"},
    )
    client.queue_notification(
        "turn/started",
        threadId="thread-1",
        turn={"id": "compact-turn-1"},
    )
    client.queue_notification(
        "item/completed",
        threadId="thread-1",
        turnId="compact-turn-1",
        item={"type": "contextCompaction", "id": "compact-item-1"},
    )
    client.queue_notification(
        "turn/completed",
        threadId="thread-1",
        turn={"id": "compact-turn-1", "status": "completed"},
    )
    session = CodexAppServerSession(
        cwd="/workspace",
        client_factory=cast(Any, lambda **_kwargs: client),
        on_event=lambda note: observed_methods.append(str(note.get("method"))),
    )

    result = session.compact_thread(
        turn_timeout=0.1,
        notification_poll_timeout=0.0,
    )
    compact_requests = [
        params for method, params in client.requests if method == "thread/compact/start"
    ]
    request_accepted = compact_requests == [{"threadId": "thread-1"}]
    terminal_observed = (
        observed_methods == ["turn/started", "item/completed", "turn/completed"]
        and result.turn_id == "compact-turn-1"
        and result.error is None
    )
    compacted = request_accepted and terminal_observed and result.compacted

    return _case(
        "runtime-compaction",
        availability="wired",
        request_acceptance="accepted" if request_accepted else "refused",
        runtime_terminal_candidate=terminal_observed,
        final_state="compacted" if compacted else "unchanged",
        refusal=None if compacted else "compaction-not-observed",
        evidence={
            "compaction_item_observed": result.compacted,
            "foreign_and_prestart_events_ignored": len(observed_methods) == 3,
            "observed_methods": observed_methods,
            "request_count": len(compact_requests),
        },
    )


def _capture_provider_unavailable() -> dict[str, Any]:
    def request_handler(method: str, params: dict[str, Any]) -> dict[str, Any]:
        del params
        if method == "thread/start":
            raise CodexAppServerError(
                code=-32603,
                message="model_provider 'synthetic-offline' not configured",
            )
        return {}

    client = FakeWireClient(request_handler)
    result = _session(client).run_turn("synthetic request", turn_timeout=0.1)
    error_text = result.error or ""
    provider_unavailable = (
        "model_provider" in error_text
        and "not configured" in error_text
        and result.final_text == ""
        and result.should_retire
    )
    thread_start_count = sum(
        method == "thread/start" for method, _params in client.requests
    )

    return _case(
        "runtime-provider-unavailable",
        availability="wired",
        request_acceptance="refused" if provider_unavailable else "accepted",
        runtime_terminal_candidate=False,
        final_state="unavailable" if provider_unavailable else "active",
        refusal="provider-unavailable" if provider_unavailable else None,
        evidence={
            "error_rendered": bool(error_text),
            "final_text_empty": result.final_text == "",
            "session_retirement_requested": result.should_retire,
            "thread_start_request_count": thread_start_count,
        },
    )


def _has_callable(value: Any, *names: str) -> bool:
    return any(callable(getattr(value, name, None)) for name in names)


def _capture_resume_unavailable() -> dict[str, Any]:
    client = FakeWireClient()
    session = _session(client)
    session.ensure_started()
    with session._active_turn_lock:
        session._active_turn_id = "turn-1"
    close_result = session.close()

    resume_callable = _has_callable(session, "resume", "resume_thread", "resume_session")
    identities_cleared = session._thread_id is None and session._active_turn_id is None
    thread_start_count = sum(
        method == "thread/start" for method, _params in client.requests
    )
    unavailable = (
        not resume_callable
        and identities_cleared
        and client.close_calls == 1
        and thread_start_count == 1
    )

    return _case(
        "session-resume-unavailable",
        availability="unavailable",
        request_acceptance="unavailable" if unavailable else "accepted",
        runtime_terminal_candidate=False,
        final_state="unavailable" if unavailable else "active",
        refusal="resume-unavailable" if unavailable else None,
        evidence={
            "close_receipt_is_none": close_result is None,
            "live_identities_cleared": identities_cleared,
            "replacement_thread_synthesized": thread_start_count != 1,
            "resume_callable": resume_callable,
        },
    )


def _capture_replay_unavailable() -> dict[str, Any]:
    client = CodexAppServerClient.__new__(CodexAppServerClient)
    client._notifications = queue.Queue()
    client._notifications.put({"method": "turn/completed", "params": {}})

    first = client.take_notification(timeout=0.0)
    second = client.take_notification(timeout=0.0)
    replay_callable = _has_callable(
        client,
        "replay",
        "replay_notifications",
        "take_notification_since",
    )
    cursor_callable = _has_callable(client, "cursor", "event_cursor", "get_cursor")
    unavailable = first is not None and second is None and not replay_callable and not cursor_callable

    return _case(
        "runtime-replay-unavailable",
        availability="unavailable",
        request_acceptance="unavailable" if unavailable else "accepted",
        runtime_terminal_candidate=False,
        final_state="unavailable" if unavailable else "active",
        refusal="durable-replay-unavailable" if unavailable else None,
        evidence={
            "cursor_callable": cursor_callable,
            "first_live_take_observed": first is not None,
            "replay_callable": replay_callable,
            "second_live_take_empty": second is None,
        },
    )


class _FakeStdin:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _FakeProcess:
    def __init__(self) -> None:
        self.stdin = _FakeStdin()
        self.terminate_calls = 0
        self.wait_calls = 0
        self.kill_calls = 0

    def terminate(self) -> None:
        self.terminate_calls += 1

    def wait(self, timeout: float) -> int:
        del timeout
        self.wait_calls += 1
        return 0

    def kill(self) -> None:
        self.kill_calls += 1


def _capture_close_proof_unavailable() -> dict[str, Any]:
    client = CodexAppServerClient.__new__(CodexAppServerClient)
    process = _FakeProcess()
    cast(Any, client)._proc = process
    client._closed = False

    first_receipt = client.close(timeout=0.01)
    second_receipt = client.close(timeout=0.01)
    close_proof_callable = _has_callable(
        client,
        "close_proof",
        "durable_close_receipt",
        "prove_thread_closed",
    )
    teardown_observed = (
        process.stdin.closed
        and process.terminate_calls == 1
        and process.wait_calls == 1
        and process.kill_calls == 0
    )
    unavailable = (
        teardown_observed
        and first_receipt is None
        and second_receipt is None
        and not close_proof_callable
    )

    return _case(
        "runtime-close-proof-unavailable",
        availability="unavailable",
        request_acceptance="unavailable" if unavailable else "accepted",
        runtime_terminal_candidate=False,
        final_state="unavailable" if unavailable else "active",
        refusal="durable-close-proof-unavailable" if unavailable else None,
        evidence={
            "close_idempotent": process.terminate_calls == 1,
            "close_proof_callable": close_proof_callable,
            "close_receipt_is_none": first_receipt is None,
            "process_teardown_observed": teardown_observed,
        },
    )


def capture_control_runtime() -> dict[str, Any]:
    """Return independently produced, content-free control observations."""
    return {
        "canonicalization": "utf8-nfc-sort-keys-compact-lf/1",
        "cases": [
            _capture_exact_steer(),
            _capture_interrupt_request(),
            _capture_stale_foreign_refusal(),
            _capture_compaction(),
            _capture_provider_unavailable(),
            _capture_resume_unavailable(),
            _capture_replay_unavailable(),
            _capture_close_proof_unavailable(),
        ],
        "schema": "costas-catalyst-control-runtime-capture/1",
    }


def test_control_runtime_capture_is_canonical_and_matches_fake_wire() -> None:
    actual = capture_control_runtime()
    raw = CAPTURE_PATH.read_bytes()
    captured = json.loads(raw)

    assert raw == _canonical(captured)
    assert captured == actual
    assert tuple(case["id"] for case in actual["cases"]) == CAPTURE_CASE_IDS
    assert all(case["product_acceptance"] is False for case in actual["cases"])


def test_control_runtime_observations_match_oracle_without_driving_capture() -> None:
    """Compare only after capture; oracle values never enter the fake drivers."""
    actual = capture_control_runtime()
    oracle = json.loads(ORACLE_PATH.read_text(encoding="utf-8"))
    oracle_cases = {
        case["id"]: case
        for case in oracle["cases"]
        if case["id"] in CAPTURE_CASE_IDS
    }

    assert set(oracle_cases) == set(CAPTURE_CASE_IDS)
    for observed in actual["cases"]:
        expected_case = oracle_cases[observed["id"]]
        assert observed["availability"] == expected_case["availability"]
        assert observed["final_state"] == expected_case["expected"]["final_state"]
        assert observed["refusal"] == expected_case["expected"]["refusal"]

    by_id = {case["id"]: case for case in actual["cases"]}
    assert by_id["control-steer-exact"]["request_acceptance"] == "accepted"
    assert by_id["control-interrupt-exact"]["request_acceptance"] == "requested"
    assert by_id["control-stale-foreign-refusal"]["request_acceptance"] == "refused"
    assert by_id["runtime-compaction"]["runtime_terminal_candidate"] is True
    assert all(
        case["runtime_terminal_candidate"] is False
        for case in actual["cases"]
        if case["id"] != "runtime-compaction"
    )
