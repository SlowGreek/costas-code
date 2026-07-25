"""Mechanical prior/input captures for the three Catalyst control reducer cells."""

from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any, Callable, Optional, cast
from unittest.mock import patch

import pytest

from agent.transports.codex_app_server_session import CodexAppServerSession
from run_agent import AIAgent

ROOT = Path(__file__).resolve().parents[2]
CORPUS_PATH = ROOT / "tests/fixtures/catalyst_oracle/corpus.json"
CAPTURE_PATH = (
    ROOT
    / "tests/fixtures/catalyst_oracle/captured/reducer-inputs/control.json"
)
CASE_IDS = (
    "control-steer-exact",
    "control-interrupt-exact",
    "control-stale-foreign-refusal",
)


def _canonical(value: Any) -> bytes:
    return (
        json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _target(thread_id: str, turn_id: str) -> dict[str, str]:
    return {"thread_id": thread_id, "turn_id": turn_id}


class _PriorSource:
    """One-shot owner seam that must run before the first control event."""

    def __init__(
        self,
        case_id: str,
        session: CodexAppServerSession,
        requests: list[dict[str, Any]],
        audit: list[str],
    ) -> None:
        self.case_id = case_id
        self.session = session
        self.requests = copy.deepcopy(requests)
        self.audit = audit
        self.snapshot: Optional[dict[str, Any]] = None

    def capture(
        self,
        *,
        request_id: str,
        control_kind: str,
        method: str,
        params: dict[str, Any],
    ) -> None:
        assert self.snapshot is None
        assert not self.audit
        with self.session._active_turn_lock:
            thread_id = self.session._thread_id
            turn_id = self.session._active_turn_id
        assert thread_id is not None and turn_id is not None

        prepared = next(
            request for request in self.requests if request["request_id"] == request_id
        )
        assert prepared["control_kind"] == control_kind
        assert prepared["method"] == method
        assert prepared["target"] == _target(thread_id, turn_id)
        assert params["threadId"] == thread_id
        request_turn = params.get("expectedTurnId", params.get("turnId"))
        assert request_turn == turn_id

        self.snapshot = {
            "active_turn": {
                "state": "active",
                "thread_id": thread_id,
                "turn_id": turn_id,
            },
            "control_requests": copy.deepcopy(self.requests),
        }
        self.audit.append("prior")


class _ControlWireClient:
    """Codex fake wire that records real calls as correlated exchanges."""

    def __init__(
        self,
        *,
        request_id: str,
        control_kind: str,
        prior_source: _PriorSource,
        control_result: dict[str, Any],
        on_turn_start: Optional[Callable[[], None]] = None,
    ) -> None:
        self.request_id = request_id
        self.control_kind = control_kind
        self.prior_source = prior_source
        self.control_result = copy.deepcopy(control_result)
        self.on_turn_start = on_turn_start
        self.exchanges: list[dict[str, Any]] = []
        self.closed = False

    def initialize(self, **_kwargs: Any) -> dict[str, str]:
        return {"userAgent": "control-reducer-fake-wire/1"}

    def request(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        del timeout
        request_params = copy.deepcopy(params or {})
        if method == "thread/start":
            return {"thread": {"id": "thread-1"}}
        if method == "turn/start":
            if self.on_turn_start is not None:
                self.on_turn_start()
            return {"turn": {"id": "turn-1"}}
        if method not in {"turn/steer", "turn/interrupt"}:
            return {}

        self.prior_source.capture(
            request_id=self.request_id,
            control_kind=self.control_kind,
            method=method,
            params=request_params,
        )
        self.prior_source.audit.append("request")
        result = copy.deepcopy(self.control_result)
        self.exchanges.append(
            {
                "control_kind": self.control_kind,
                "method": method,
                "params": request_params,
                "request_id": self.request_id,
                "result": result,
            }
        )
        self.prior_source.audit.append("receipt")
        return result

    def take_notification(self, timeout: float = 0.0) -> None:
        del timeout
        return None

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

    def stderr_tail(self, n: int = 20) -> list[str]:
        del n
        return []

    def is_alive(self) -> bool:
        return not self.closed

    def close(self) -> None:
        self.closed = True


def _session(client: _ControlWireClient) -> CodexAppServerSession:
    return CodexAppServerSession(
        cwd="/workspace",
        client_factory=cast(Any, lambda **_kwargs: client),
    )


def _bare_codex_agent(session: CodexAppServerSession) -> AIAgent:
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


def _prepared_request(
    request_id: str,
    control_kind: str,
    *,
    turn_id: str = "turn-1",
    state: str = "prepared",
) -> dict[str, Any]:
    method = "turn/steer" if control_kind == "steer" else "turn/interrupt"
    return {
        "control_kind": control_kind,
        "method": method,
        "request_id": request_id,
        "state": state,
        "target": _target("thread-1", turn_id),
    }


def _events(
    exchange: dict[str, Any],
    *,
    request_partition: str,
) -> list[dict[str, Any]]:
    params = copy.deepcopy(exchange["params"])
    result = copy.deepcopy(exchange["result"])
    request_turn = params.get("expectedTurnId", params.get("turnId"))
    request_target = _target(params["threadId"], request_turn)
    receipt = {
        "control_kind": exchange["control_kind"],
        "kind": "control.receipt",
        "method": exchange["method"],
        "partition": "control",
        "request_id": exchange["request_id"],
        "request_target": request_target,
        "result": result,
        "seq": 1,
    }
    response_turn = result.get("turnId")
    if response_turn is not None:
        receipt["response_target"] = _target(params["threadId"], response_turn)
    return [
        {
            "control_kind": exchange["control_kind"],
            "kind": "control.request",
            "method": exchange["method"],
            "params": params,
            "partition": request_partition,
            "request_id": exchange["request_id"],
            "seq": 0,
        },
        receipt,
    ]


def _case(case_id: str, prior: dict[str, Any], events: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "disposition": "reduced",
        "events": events,
        "id": case_id,
        "prior": prior,
        "privacy": "synthetic-bounded",
        "source_receipt": {
            "owner": "Costas Codex fake-wire owner seam",
            "runtime": "AIAgent/CodexAppServerSession",
        },
    }


def _capture_steer(
    *,
    case_id: str,
    request_id: str,
    response_turn_id: str,
    text: str,
    unrelated: Optional[dict[str, Any]] = None,
) -> tuple[dict[str, Any], list[str]]:
    audit: list[str] = []
    planned = [_prepared_request(request_id, "steer")]
    if unrelated is not None:
        planned.append(copy.deepcopy(unrelated))

    placeholder = cast(Any, object())
    prior_source = cast(_PriorSource, placeholder)
    client = cast(_ControlWireClient, placeholder)
    session = CodexAppServerSession(
        cwd="/workspace",
        client_factory=cast(Any, lambda **_kwargs: client),
    )
    prior_source = _PriorSource(case_id, session, planned, audit)
    client = _ControlWireClient(
        request_id=request_id,
        control_kind="steer",
        prior_source=prior_source,
        control_result={"turnId": response_turn_id},
    )

    session.ensure_started()
    with session._active_turn_lock:
        session._active_turn_id = "turn-1"
    agent = _bare_codex_agent(session)
    accepted = agent.redirect(text) if case_id == "control-steer-exact" else session.request_steer(text)
    assert accepted is (response_turn_id == "turn-1")
    assert prior_source.snapshot is not None
    assert len(client.exchanges) == 1
    return (
        _case(
            case_id,
            prior_source.snapshot,
            _events(client.exchanges[0], request_partition="private"),
        ),
        audit,
    )


def _capture_interrupt() -> tuple[dict[str, Any], list[str]]:
    audit: list[str] = []
    request_id = "control-interrupt-exact-request-1"
    planned = [_prepared_request(request_id, "interrupt")]

    placeholder = cast(Any, object())
    prior_source = cast(_PriorSource, placeholder)
    client = cast(_ControlWireClient, placeholder)
    session = CodexAppServerSession(
        cwd="/workspace",
        client_factory=cast(Any, lambda **_kwargs: client),
    )
    prior_source = _PriorSource("control-interrupt-exact", session, planned, audit)
    client = _ControlWireClient(
        request_id=request_id,
        control_kind="interrupt",
        prior_source=prior_source,
        control_result={},
    )
    agent = _bare_codex_agent(session)

    def interrupt_twice() -> None:
        agent.interrupt()
        agent.interrupt()

    client.on_turn_start = interrupt_twice
    result = session.run_turn(
        "synthetic request",
        notification_poll_timeout=0.0,
        turn_timeout=0.1,
    )
    assert result.interrupted
    assert prior_source.snapshot is not None
    assert len(client.exchanges) == 1
    return (
        _case(
            "control-interrupt-exact",
            prior_source.snapshot,
            _events(client.exchanges[0], request_partition="control"),
        ),
        audit,
    )


def capture_control_reducer_inputs() -> tuple[dict[str, Any], dict[str, list[str]]]:
    """Capture priors first, then normalized events, without expected data."""
    steer, steer_audit = _capture_steer(
        case_id="control-steer-exact",
        request_id="control-steer-exact-request-1",
        response_turn_id="turn-1",
        text="  synthetic correction  ",
    )
    interrupt, interrupt_audit = _capture_interrupt()
    unrelated = _prepared_request(
        "control-unrelated-pending-request-1",
        "interrupt",
        turn_id="turn-unrelated",
        state="pending",
    )
    stale, stale_audit = _capture_steer(
        case_id="control-stale-foreign-refusal",
        request_id="control-stale-foreign-request-1",
        response_turn_id="turn-foreign",
        text="synthetic stale guidance",
        unrelated=unrelated,
    )
    artifact = {
        "canonicalization": "utf8-nfc-sort-keys-compact-lf/1",
        "cases": [steer, interrupt, stale],
        "schema": "costas-catalyst-control-reducer-inputs/1",
    }
    return artifact, {
        "control-interrupt-exact": interrupt_audit,
        "control-stale-foreign-refusal": stale_audit,
        "control-steer-exact": steer_audit,
    }


def _fold(case: dict[str, Any]) -> dict[str, Any]:
    prior = copy.deepcopy(case["prior"])
    request, receipt = case["events"]
    assert request["kind"] == "control.request"
    assert receipt["kind"] == "control.receipt"
    assert request["seq"] == 0 and receipt["seq"] == 1
    assert request["request_id"] == receipt["request_id"]
    assert request["control_kind"] == receipt["control_kind"]
    assert request["method"] == receipt["method"]

    requests = {item["request_id"]: item for item in prior["control_requests"]}
    matched = requests[request["request_id"]]
    assert matched["state"] == "prepared"
    assert matched["control_kind"] == request["control_kind"]
    assert matched["method"] == request["method"]

    active = prior["active_turn"]
    request_turn = request["params"].get(
        "expectedTurnId", request["params"].get("turnId")
    )
    assert matched["target"] == _target(active["thread_id"], active["turn_id"])
    assert request["params"]["threadId"] == active["thread_id"]
    assert request_turn == active["turn_id"]
    assert receipt["request_target"] == matched["target"]

    refusal = None
    if request["control_kind"] == "steer":
        response_turn = receipt["result"].get("turnId")
        assert receipt["response_target"] == _target(
            active["thread_id"], response_turn
        )
        if response_turn in {None, active["turn_id"]}:
            matched["state"] = "accepted"
            final_state = "active-steered"
        else:
            matched["state"] = "refused"
            matched["rejected_target"] = _target(active["thread_id"], response_turn)
            final_state = "unchanged"
            refusal = "stale-or-foreign-target"
    else:
        assert request["control_kind"] == "interrupt"
        assert receipt["result"] == {}
        matched["state"] = "requested"
        final_state = "interrupt-pending"

    return {
        "active_turn": active,
        "control_requests": list(requests.values()),
        "final_state": final_state,
        "refusal": refusal,
    }


def _corpus_control_expectations() -> dict[str, dict[str, Any]]:
    corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    return {
        case["id"]: case["expected"]
        for case in corpus["cases"]
        if case["id"] in CASE_IDS
    }


def test_capture_precedes_events_and_expected_data_is_inaccessible() -> None:
    blocked = {CORPUS_PATH.resolve(), CAPTURE_PATH.resolve()}
    real_open = Path.open

    def guarded_open(path: Path, *args: Any, **kwargs: Any) -> Any:
        if path.resolve() in blocked:
            raise AssertionError("capture attempted to read expected or committed bytes")
        return real_open(path, *args, **kwargs)

    with patch.object(Path, "open", guarded_open):
        actual, audits = capture_control_reducer_inputs()
        serialized = _canonical(actual)

    assert serialized
    assert set(audits) == set(CASE_IDS)
    assert all(order == ["prior", "request", "receipt"] for order in audits.values())


def test_control_reducer_capture_is_canonical_and_matches_fake_wire() -> None:
    actual, _audits = capture_control_reducer_inputs()
    raw = CAPTURE_PATH.read_bytes()
    captured = json.loads(raw)

    assert raw == _canonical(captured)
    assert captured == actual
    assert tuple(case["id"] for case in captured["cases"]) == CASE_IDS
    for case in captured["cases"]:
        assert [event["kind"] for event in case["events"]] == [
            "control.request",
            "control.receipt",
        ]
        assert all(event["method"].startswith("turn/") for event in case["events"])
        assert "params" in case["events"][0]
        assert "result" in case["events"][1]


def test_priors_are_independent_of_later_receipts() -> None:
    accepted, _ = _capture_steer(
        case_id="control-steer-exact",
        request_id="same-request",
        response_turn_id="turn-1",
        text="synthetic correction",
    )
    rejected, _ = _capture_steer(
        case_id="control-stale-foreign-refusal",
        request_id="same-request",
        response_turn_id="turn-foreign",
        text="synthetic correction",
    )

    assert accepted["prior"] == rejected["prior"]
    assert accepted["events"][1] != rejected["events"][1]
    prior_before = copy.deepcopy(accepted["prior"])
    accepted["events"][1]["result"]["turnId"] = "mutated-later"
    assert accepted["prior"] == prior_before


def test_stale_refusal_is_correlated_and_preserves_unrelated_pending_control() -> None:
    actual, _audits = capture_control_reducer_inputs()
    stale = next(
        case for case in actual["cases"] if case["id"] == "control-stale-foreign-refusal"
    )
    request, receipt = stale["events"]
    folded = _fold(stale)
    controls = {item["request_id"]: item for item in folded["control_requests"]}

    assert stale["prior"]["active_turn"] == {
        "state": "active",
        "thread_id": "thread-1",
        "turn_id": "turn-1",
    }
    assert request["params"]["expectedTurnId"] == "turn-1"
    assert receipt["request_target"] == _target("thread-1", "turn-1")
    assert receipt["result"]["turnId"] == "turn-foreign"
    assert receipt["response_target"] == _target("thread-1", "turn-foreign")
    assert request["request_id"] == receipt["request_id"]
    assert request["control_kind"] == receipt["control_kind"] == "steer"
    assert controls[request["request_id"]]["rejected_target"] == _target(
        "thread-1", "turn-foreign"
    )
    assert controls["control-unrelated-pending-request-1"]["state"] == "pending"


def test_folded_inputs_match_expected_only_after_capture_serialization() -> None:
    actual, _audits = capture_control_reducer_inputs()
    serialized = _canonical(actual)
    assert serialized
    expected = _corpus_control_expectations()

    assert set(expected) == set(CASE_IDS)
    for case in actual["cases"]:
        folded = _fold(case)
        assert folded["final_state"] == expected[case["id"]]["final_state"]
        assert folded["refusal"] == expected[case["id"]]["refusal"]


@pytest.mark.parametrize("case_id", CASE_IDS)
def test_prior_mutation_breaks_parity(case_id: str) -> None:
    actual, _audits = capture_control_reducer_inputs()
    case = copy.deepcopy(next(item for item in actual["cases"] if item["id"] == case_id))
    case["prior"]["active_turn"]["turn_id"] = "turn-mutated"

    with pytest.raises(AssertionError):
        _fold(case)


@pytest.mark.parametrize("case_id", CASE_IDS)
def test_event_mutation_breaks_parity(case_id: str) -> None:
    actual, _audits = capture_control_reducer_inputs()
    case = copy.deepcopy(next(item for item in actual["cases"] if item["id"] == case_id))
    request = case["events"][0]
    turn_key = "expectedTurnId" if case_id != "control-interrupt-exact" else "turnId"
    request["params"][turn_key] = "turn-mutated"

    with pytest.raises(AssertionError):
        _fold(case)
